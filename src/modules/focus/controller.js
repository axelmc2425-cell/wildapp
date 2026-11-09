// Focus Room UI controller: owns state, serializes every write, and keeps the helper in sync.
import * as store from './store.js';
import { groupSessions, parseDuration, classifyHelperFailure, describePushProblem } from './model.js';
import { syncWindows } from './sync.js';
import { describeUnlockError, windowIdForBlock, pendingUnlockFor, resolveDelayHours } from './lock-logic.js';

const MIN = 60000;
const MAX_MINUTES = 1440;
const PUSH_REJECTION_CODES = new Set(['bad-window', 'too-many', 'allow-needs-apps', 'frozen-unavailable']);
const MAX_LOCKED_MINUTES = 10080;
const NOT_SENT = 'Not sent. The lock is unchanged.';
const FINISHED = 'That block has already finished.';

const errText = (e) => {
  try { return String((e && e.message) ?? e ?? 'unknown error'); } catch { return 'unknown error'; }
};

/** A client-like object for when there is no helper (browser, development). */
export function createUnavailableClient(message) {
  const fail = async () => {
    const e = new Error(message);
    e.code = 'unreachable';
    throw e;
  };
  return {
    pushWindows: fail, status: fail, requestChallenge: fail, submitToken: fail, setPartner: fail,
    requestDelayedUnlock: fail, cancelDelayedUnlock: fail,
  };
}

export const HELPER_UNAVAILABLE_CLIENT = createUnavailableClient(
  'The Focus Room helper is only available in the desktop app.',
);

export function createController({ db, client, now, tzOffsetAt, onChange }) {
  let lists = [];
  let sessions = [];
  let helper = { kind: 'unknown', message: 'Checking the helper…' };
  let syncPending = false;
  let lastSync = null;
  let notice = null;
  let loaded = false;
  let partnerSet = false;
  let partnerName = null;

  const changed = () => { try { onChange?.(); } catch { /* UI callback must not break the controller */ } };

  // ONE queue for every write and every push, so store id read-backs see a single writer.
  let chain = Promise.resolve();
  let inflight = 0; // queued or running operations
  let epoch = 0; // operations that have started; lets an unqueued status poll tell it may be stale
  const enqueue = (fn, { quiet = false } = {}) => {
    inflight++;
    const run = () => { if (!quiet) epoch++; return fn(); };
    const p = chain.then(run, run);
    chain = p.then(() => undefined, () => undefined);
    const done = () => { inflight--; };
    p.then(done, done);
    return p;
  };

  async function reload() {
    lists = await store.listLists(db);
    sessions = await store.listSessions(db);
    const [p] = await db.all('SELECT name FROM focus_partner LIMIT 1');
    partnerName = p && typeof p.name === 'string' ? p.name : null;
  }

  // Sequence guard: a status result is applied only if nothing newer decided the helper state since
  // it started, and an ok status never paints over an unsent (syncPending) block.
  let seq = 0;
  const STALE_NOTICE = 'Saved, but the list on screen may be out of date. Reopen the Focus Room to refresh.';
  async function reloadSafe() {
    try { await reload(); return true; } catch { return false; }
  }
  async function doResyncAfter(reloaded) {
    const ok = await doResync();
    if (!reloaded && notice === null) { notice = STALE_NOTICE; changed(); }
    return ok;
  }

  // Runs inside the queue. Returns the status when it was applied to state, else null.
  async function pollStatus() {
    const mine = ++seq;
    let applied = null;
    try {
      const status = await client.status();
      if (mine === seq && !syncPending) { helper = { kind: 'ok', status }; applied = status; }
      if (status && typeof status.partner_set === 'boolean') partnerSet = status.partner_set;
    } catch (err) {
      if (mine === seq) {
        try { helper = classifyHelperFailure(err); } catch { helper = { kind: 'unknown', message: 'Unknown error' }; }
      }
    }
    changed();
    return applied;
  }

  // Runs inside the queue. The helper's copy of a lock wins: a running locked block it no longer
  // holds (ended by token or wait) is removed here. Only called with a status that was just applied,
  // so an unsent (syncPending) change can never look like a block the helper dropped.
  async function reconcile(status) {
    if (!status || !Array.isArray(status.windows)) return;
    try {
      await reload();
      const t = now();
      const held = new Set(status.windows.map((w) => w && w.id));
      const gone = groupSessions(sessions, lists, t)
        .filter((b) => b.lock === 'locked' && t < b.ends && !held.has(windowIdForBlock(b)));
      if (!gone.length) return;
      await store.endLockedSessions(db, gone.flatMap((b) => b.ids));
      await reloadSafe();
      changed();
    } catch { /* retried on the next poll */ }
  }

  async function pollAndReconcile() {
    await reconcile(await pollStatus());
  }

  // The poll itself runs outside the queue (a slow helper must not stall writes), so reconcile only
  // acts on its status when no write was running at the start and none has started since.
  async function refreshStatus() {
    const idle = inflight === 0;
    const e0 = epoch;
    const status = await pollStatus();
    if (!idle || !status) return;
    await enqueue(async () => { if (epoch === e0) await reconcile(status); }, { quiet: true });
  }

  // Runs inside the queue. Returns true when the helper accepted the push.
  async function doResync() {
    try {
      lastSync = await syncWindows(db, client, now(), tzOffsetAt);
      syncPending = false;
      notice = null;
      await pollAndReconcile();
      changed();
      return true;
    } catch (err) {
      syncPending = true;
      seq++;
      try { helper = classifyHelperFailure(err); } catch { helper = { kind: 'unknown', message: 'Unknown error' }; }
      try {
        notice = err && PUSH_REJECTION_CODES.has(err.code)
          ? describePushProblem(err, lastSync?.skipped ?? 0, lists.map((l) => l.name))
          : null;
      } catch { notice = null; }
      changed();
      return false;
    }
  }

  let queuedResync = null;
  function resync() {
    if (!queuedResync) {
      queuedResync = enqueue(async () => { queuedResync = null; await doResync(); });
    }
    return queuedResync;
  }

  const dbFail = (e) => ({ ok: false, message: `Could not save: ${errText(e)}` });

  function load() {
    return enqueue(async () => {
      try {
        await store.purgeFinished(db, now());
        await reload();
        loaded = true;
        changed();
      } catch (e) {
        notice = `Could not read your focus data: ${errText(e)}`;
        loaded = true;
        changed();
        return;
      }
      await doResync();
    });
  }

  function saveList(input) {
    return enqueue(async () => {
      let res;
      try {
        res = await store.saveList(db, input, now());
      } catch (e) {
        const msg = errText(e);
        return { ok: false, errors: { name: msg === 'no such list' ? 'That list no longer exists.' : `Could not save: ${msg}` } };
      }
      if (!res.ok) return res;
      try { await reload(); } catch { /* state refreshes on the next load */ }
      changed();
      await doResync();
      return res;
    });
  }

  function deleteList(id) {
    return enqueue(async () => {
      let res;
      try {
        res = await store.deleteList(db, id, now());
      } catch (e) {
        return { ok: false, reason: 'error', message: `Could not delete: ${errText(e)}` };
      }
      if (!res.ok) return res;
      try { await reload(); } catch { /* see above */ }
      changed();
      await doResync();
      return res;
    });
  }

  function startBlock(input) {
    return enqueue(async () => {
      const { listIds, minutes } = input || {};
      if (!Array.isArray(listIds) || listIds.length === 0) return { ok: false, message: 'Pick at least one list.' };
      const d = parseDuration({ custom: String(minutes) });
      if (!d.ok) return { ok: false, message: d.message };
      try {
        await reload();
        const ids = [...new Set(listIds)];
        if (!ids.every((id) => lists.some((l) => l.id === id))) {
          return { ok: false, message: 'One of those lists no longer exists.' };
        }
        const starts = now();
        await store.createSessions(db, { listIds: ids, starts, ends: starts + d.minutes * MIN });
      } catch (e) {
        return dbFail(e);
      }
      const reloaded = await reloadSafe();
      changed();
      await doResyncAfter(reloaded);
      return { ok: true };
    });
  }

  async function findLiveBlock(key) {
    await reload();
    const t = now();
    return groupSessions(sessions, lists, t).find((b) => b.key === key && b.state !== 'finished') || null;
  }

  function extendBlock(key, addMinutes) {
    return enqueue(async () => {
      if (!Number.isInteger(addMinutes) || addMinutes < 1) {
        return { ok: false, message: 'Enter a whole number of minutes from 1 to 1440.' };
      }
      try {
        const block = await findLiveBlock(key);
        if (!block) return { ok: false, message: FINISHED };
        const locked = block.lock === 'locked';
        const cap = block.starts + (locked ? MAX_LOCKED_MINUTES : MAX_MINUTES) * MIN;
        if (block.ends >= cap) {
          return { ok: false, message: locked ? 'A locked block can be at most 7 days long.' : 'A block can be at most 24 hours long.' };
        }
        await store.setSessionsEnd(db, block.ids, Math.min(block.ends + addMinutes * MIN, cap));
      } catch (e) {
        return dbFail(e);
      }
      const reloaded = await reloadSafe();
      changed();
      await doResyncAfter(reloaded);
      return { ok: true };
    });
  }

  function cancelBlock(key) {
    return enqueue(async () => {
      let block;
      try {
        block = await findLiveBlock(key);
        if (!block) return { ok: false, message: FINISHED };
        if (block.lock !== 'none') return { ok: false, message: 'A locked block cannot be cancelled. Use Unlock early.' };
        await store.deleteSessions(db, block.ids);
      } catch (e) {
        return dbFail(e);
      }
      const reloaded = await reloadSafe();
      changed();
      const ok = await doResyncAfter(reloaded);
      return ok ? { ok: true, helperStopped: true } : { ok: true, helperStopped: false, enforcedUntil: block.ends };
    });
  }

  // Plain reason for a helper that could not be reached or refused.
  function plainReason(err) {
    let h;
    try { h = classifyHelperFailure(err); } catch { h = { kind: 'unknown' }; }
    if (h.kind === 'not-running') return 'The Focus Room helper is not running.';
    if (h.kind === 'timeout') return 'The Focus Room helper did not answer in time.';
    if (h.kind === 'unavailable') return 'The Focus Room helper is only available in the desktop app.';
    return describeUnlockError(err);
  }
  const unreachable = (err) => {
    if (err && err.code === 'unreachable') return true;
    try { return ['not-running', 'timeout', 'unavailable'].includes(classifyHelperFailure(err).kind); } catch { return false; }
  };
  const requestFailure = (err) => ({ ok: false, message: unreachable(err) ? NOT_SENT : describeUnlockError(err) });

  function startLockedBlock(input) {
    return enqueue(async () => {
      const { listIds, minutes, delayHours } = input || {};
      if (!Array.isArray(listIds) || listIds.length === 0) return { ok: false, message: 'Pick at least one list.' };
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LOCKED_MINUTES) {
        return { ok: false, message: 'Enter a whole number of minutes from 1 to 10080 (7 days).' };
      }
      const delay = resolveDelayHours(typeof delayHours === 'number' ? { preset: delayHours } : { custom: delayHours });
      if (!delay.ok) return { ok: false, message: delay.message };
      let uniq;
      try {
        await reload();
        uniq = [...new Set(listIds)];
        if (!uniq.every((id) => lists.some((l) => l.id === id))) {
          return { ok: false, message: 'One of those lists no longer exists.' };
        }
      } catch (e) {
        return dbFail(e);
      }
      let status;
      try {
        status = await client.status();
      } catch (err) {
        return { ok: false, message: `Nothing was locked. ${plainReason(err)}` };
      }
      if (!status || status.partner_set !== true) {
        return { ok: false, message: "Nothing was locked. Add your partner's key first, so someone else can end it early if you need." };
      }
      let ids;
      try {
        const starts = now();
        ids = await store.createSessions(db, {
          listIds: uniq, starts, ends: starts + minutes * MIN, lock: 'locked', unlockDelayMs: delay.hours * 3600000,
        });
      } catch (e) {
        return dbFail(e);
      }
      const priorPending = syncPending;
      try {
        lastSync = await syncWindows(db, client, now(), tzOffsetAt);
      } catch (err) {
        let undone = true;
        try { await store.endLockedSessions(db, ids); } catch { undone = false; }
        syncPending = priorPending;
        await reloadSafe();
        changed();
        if (!undone) {
          syncPending = true;
          return { ok: false, message: 'The helper refused the lock, and it could not be undone here. Reopen the Focus Room to check.' };
        }
        return { ok: false, message: `Nothing was locked. ${plainReason(err)}` };
      }
      syncPending = false;
      notice = null;
      await reloadSafe();
      await pollAndReconcile();
      changed();
      return { ok: true };
    });
  }

  // Shared shape of the four lock requests: find the live locked block by the key given, ask the helper.
  function lockRequest(blockKey, call, done) {
    return enqueue(async () => {
      let block;
      try {
        block = typeof blockKey === 'string' ? await findLiveBlock(blockKey) : null;
      } catch (e) {
        return dbFail(e);
      }
      if (!block) return { ok: false, message: describeUnlockError({ code: 'no-such-lock' }) };
      if (block.lock !== 'locked') return { ok: false, message: 'That block is not locked.' };
      const windowId = windowIdForBlock(block);
      let res;
      try {
        res = await call(windowId);
      } catch (err) {
        return requestFailure(err);
      }
      await pollAndReconcile();
      changed();
      return done(res, windowId);
    });
  }

  function requestPartnerChallenge(blockKey) {
    return lockRequest(blockKey, (id) => client.requestChallenge(id), (res) => (
      res && typeof res.code === 'string' && res.code
        ? { ok: true, code: res.code }
        : { ok: false, message: 'The helper sent an unreadable reply. Try again.' }));
  }

  function submitPartnerToken(blockKey, token) {
    if (typeof token !== 'string' || token.trim() === '' || token.length > 4096) {
      return Promise.resolve({ ok: false, message: describeUnlockError({ code: 'bad-format' }) });
    }
    return lockRequest(blockKey, () => client.submitToken(token.trim()), () => ({ ok: true }));
  }

  function startDelayedUnlock(blockKey) {
    return lockRequest(blockKey, (id) => client.requestDelayedUnlock(id), (res, id) => {
      const at = res && Number.isFinite(res.unlock_at) ? res.unlock_at : pendingUnlockFor(helper.status, id);
      return at == null
        ? { ok: false, message: 'The helper sent an unreadable reply. Try again.' }
        : { ok: true, unlockAt: at };
    });
  }

  function cancelDelayedUnlock(blockKey) {
    return lockRequest(blockKey, (id) => client.cancelDelayedUnlock(id), () => ({ ok: true }));
  }

  function setPartner(input) {
    return enqueue(async () => {
      const { publicKey, name } = input || {};
      const key = typeof publicKey === 'string' ? publicKey.trim() : '';
      const nm = typeof name === 'string' ? name.trim() : '';
      if (!key || key.length > 1024) return { ok: false, message: describeUnlockError({ code: 'bad-key' }) };
      if (!nm || nm.length > 60) return { ok: false, message: 'Enter your partner\'s name (up to 60 characters).' };
      try {
        await client.setPartner(key);
      } catch (err) {
        return unreachable(err)
          ? { ok: false, message: 'Not sent. Your partner was not changed.' }
          : { ok: false, message: describeUnlockError(err) };
      }
      try {
        await db.batch([
          { sql: 'DELETE FROM focus_partner' },
          { sql: 'INSERT INTO focus_partner(public_key, name) VALUES (?, ?)', params: [key, nm] },
        ]);
      } catch (e) {
        await pollAndReconcile();
        return { ok: false, message: `The helper accepted the key, but the name could not be saved: ${errText(e)}` };
      }
      await reloadSafe();
      await pollAndReconcile();
      changed();
      return { ok: true };
    });
  }

  return {
    get state() {
      return {
        loaded, lists, blocks: groupSessions(sessions, lists, now()), helper, syncPending, lastSync, notice,
        partner: { set: partnerSet, name: partnerSet ? partnerName : null },
      };
    },
    load, saveList, deleteList, startBlock, extendBlock, cancelBlock, refreshStatus, resync,
    startLockedBlock, setPartner, requestPartnerChallenge, submitPartnerToken, startDelayedUnlock, cancelDelayedUnlock,
  };
}
