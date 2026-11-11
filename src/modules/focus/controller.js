// Focus Room UI controller: owns state, serializes every write, and keeps the helper in sync.
import * as store from './store.js';
import { groupSessions, parseDuration, classifyHelperFailure, describePushProblem } from './model.js';
import { syncWindows } from './sync.js';
import { scheduleBlocks, nextOccurrence } from './schedule-logic.js';
import { makeTzOffsetAt } from './tz.js';
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
    requestDelayedUnlock: fail, cancelDelayedUnlock: fail, getUsage: fail,
  };
}

export const HELPER_UNAVAILABLE_CLIENT = createUnavailableClient(
  'The Focus Room helper is only available in the desktop app.',
);

export function createController({ db, client, now, tzOffsetAt = makeTzOffsetAt(), onChange }) {
  let lists = [];
  let schedules = [];
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

  // Session blocks plus running locked schedule occurrences (ids: [], so no session write can act on them).
  function allBlocks(t) {
    const byId = new Map(lists.map((l) => [l.id, l]));
    return [...groupSessions(sessions, lists, t), ...scheduleBlocks(schedules, byId, t, tzOffsetAt)]
      .sort((x, y) => x.ends - y.ends);
  }

  async function reload() {
    lists = await store.listLists(db);
    sessions = await store.listSessions(db);
    schedules = await store.listSchedules(db);
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

  // Ids of windows the helper still holds. The real helper ends a window early by pulling its end back
  // to "now" and keeps listing it until it is pruned, so a window with ends <= now_ms is not held.
  function heldIds(status) {
    const helperNow = status && Number.isFinite(status.now_ms) ? status.now_ms : null;
    const list = status && Array.isArray(status.windows) ? status.windows : [];
    return new Set(list
      .filter((w) => w && !(helperNow !== null && Number.isFinite(w.ends) && w.ends <= helperNow))
      .map((w) => w.id));
  }

  // Runs inside the queue. The helper's copy of a lock wins: a running locked block it no longer
  // holds (ended by token or wait) is removed here. Only called with a status that was just applied,
  // so an unsent (syncPending) change can never look like a block the helper dropped.
  async function reconcile(status) {
    if (!status || !Array.isArray(status.windows)) return;
    try {
      await reload();
      const t = now();
      // The real helper ends a window early by pulling its end back to "now" and keeps listing it until
      // it is pruned, so a window already over on the helper's own clock is not held any more.
      const held = heldIds(status);
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
        res = await store.saveList(db, input, now(), tzOffsetAt);
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
        res = await store.deleteList(db, id, now(), tzOffsetAt);
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

  // Shared by the schedule writes: run the store call, then reload, notify and push like deleteList.
  function scheduleWrite(call, failShape) {
    return enqueue(async () => {
      let res;
      try {
        res = await call();
      } catch (e) {
        const msg = errText(e);
        return failShape(msg);
      }
      if (!res.ok) return res;
      try { await reload(); } catch { /* state refreshes on the next load */ }
      changed();
      await doResync();
      return res;
    });
  }

  const HORIZON_MS = 30 * 86400000;
  const SCHEDULE_PARTNER_MSG = "Nothing was saved. Add your partner's key first, so someone else can end it early if you need.";

  // A locked schedule is saved only if the helper will hold it: check the helper and partner first,
  // push, confirm the first occurrence is on the helper, and undo the save if it is not.
  function saveSchedule(input) {
    const lockedInput = !!input && input.lock === 'locked';
    if (!lockedInput) {
      return scheduleWrite(
        () => store.saveSchedule(db, input, now(), tzOffsetAt),
        (msg) => ({ ok: false, errors: { name: msg === 'no such schedule' ? 'That schedule no longer exists.' : `Could not save: ${msg}` } }),
      );
    }
    return enqueue(async () => {
      let status;
      try {
        status = await client.status();
      } catch (err) {
        return { ok: false, message: `Nothing was saved. ${plainReason(err)}` };
      }
      if (!status || status.partner_set !== true) return { ok: false, message: SCHEDULE_PARTNER_MSG };
      let prev = null;
      let res;
      try {
        if (input.id !== undefined) prev = await store.readSchedule(db, input.id);
        res = await store.saveSchedule(db, input, now(), tzOffsetAt);
      } catch (e) {
        const msg = errText(e);
        return { ok: false, errors: { name: msg === 'no such schedule' ? 'That schedule no longer exists.' : `Could not save: ${msg}` } };
      }
      if (!res.ok) return res;
      const reloaded = await reloadSafe();
      changed();
      await doResyncAfter(reloaded);
      // The first occurrence the helper should now hold, if one falls inside the pushed horizon.
      const t = now();
      const rec = (await store.readSchedule(db, res.id).catch(() => null));
      const n = rec ? nextOccurrence(rec, t, tzOffsetAt) : null;
      const ends = n && n.state !== 'ended' && Number.isFinite(n.ends) ? n.ends : null;
      if (ends === null || !(n.starts < t + HORIZON_MS)) return res;
      const wid = `c${res.id}@${n.starts}`;
      let held = null;
      try {
        const st = await client.status();
        held = Array.isArray(st && st.windows) && heldIds(st).has(wid);
      } catch { held = null; }
      if (held === true) return res;
      if (held === null) {
        syncPending = true;
        seq++;
        changed();
        return { ok: true, id: res.id, unconfirmed: true, message: "The lock is saved, but we couldn't confirm it with the helper, so it may not be enforced yet. Check the Focus Room." };
      }
      let undone = true;
      try { await store.restoreSchedule(db, res.id, prev); } catch { undone = false; }
      await reloadSafe();
      changed();
      if (!undone) {
        syncPending = true;
        return { ok: false, message: 'The helper did not take the lock, and the save could not be undone here. Reopen the Focus Room to check.' };
      }
      await doResync();
      return { ok: false, message: 'Nothing was saved. The helper did not take the lock.' };
    });
  }
  const setScheduleEnabled = (id, enabled) => scheduleWrite(
    () => store.setScheduleEnabled(db, id, enabled, now(), tzOffsetAt),
    (msg) => ({ ok: false, reason: 'error', message: `Could not save: ${msg}` }),
  );
  const deleteSchedule = (id) => scheduleWrite(
    () => store.deleteSchedule(db, id, now(), tzOffsetAt),
    (msg) => ({ ok: false, reason: 'error', message: `Could not delete: ${msg}` }),
  );

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
    return allBlocks(t).find((b) => b.key === key && b.state !== 'finished') || null;
  }

  function extendBlock(key, addMinutes) {
    return enqueue(async () => {
      if (!Number.isInteger(addMinutes) || addMinutes < 1) {
        return { ok: false, message: 'Enter a whole number of minutes from 1 to 1440.' };
      }
      try {
        let block = await findLiveBlock(key);
        if (!block) return { ok: false, message: FINISHED };
        if (block.scheduleId !== undefined) return { ok: false, message: 'Edit the schedule instead.' };
        const locked = block.lock === 'locked';
        if (locked) {
          // The helper may have just ended this lock (wait expired); extending now would revive it.
          await pollAndReconcile();
          block = await findLiveBlock(key);
          if (!block || block.scheduleId !== undefined) return { ok: false, message: 'This lock has just ended, so it cannot be extended.' };
        }
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
  const isTimeout = (err) => { try { return classifyHelperFailure(err).kind === 'timeout'; } catch { return false; } };
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
      let starts0;
      try {
        starts0 = now();
        ids = await store.createSessions(db, {
          listIds: uniq, starts: starts0, ends: starts0 + minutes * MIN, lock: 'locked', unlockDelayMs: delay.hours * 3600000,
        });
      } catch (e) {
        return dbFail(e);
      }
      const priorPending = syncPending;
      const wid = windowIdForBlock({ starts: starts0, listIds: uniq });
      const rollback = async (reason) => {
        let undone = true;
        try { await store.endLockedSessions(db, ids); } catch { undone = false; }
        syncPending = priorPending;
        await reloadSafe();
        changed();
        if (!undone) {
          syncPending = true;
          return { ok: false, message: 'The helper did not take the lock, and it could not be undone here. Reopen the Focus Room to check.' };
        }
        return { ok: false, message: `Nothing was locked. ${reason}` };
      };
      // true: the helper holds the new window; false: it does not; null: could not tell.
      const holds = async () => {
        try {
          const st = await client.status();
          return Array.isArray(st && st.windows) && heldIds(st).has(wid);
        } catch { return null; }
      };
      const unconfirmed = () => {
        syncPending = true;
        seq++;
        changed();
        return { ok: true, unconfirmed: true, message: "Couldn't confirm the lock with the helper. It may be on. Check the Focus Room." };
      };
      const confirmed = async (message) => {
        syncPending = false;
        notice = null;
        await reloadSafe();
        await pollAndReconcile();
        changed();
        return message ? { ok: true, message } : { ok: true };
      };
      let pushErr = null;
      try {
        lastSync = await syncWindows(db, client, now(), tzOffsetAt);
      } catch (err) { pushErr = err; }
      if (pushErr) {
        const code = pushErr && pushErr.code;
        const ambiguous = code === 'persist-failed' || isTimeout(pushErr);
        const definite = !ambiguous && (PUSH_REJECTION_CODES.has(code) || code === 'no-partner' || unreachable(pushErr));
        // Anything else (timeout, persist-failed, unknown) may have applied: ask the helper.
        if (definite) return rollback(plainReason(pushErr));
        const present = await holds();
        if (present === null) return unconfirmed();
        if (!present) return rollback(plainReason(pushErr));
        return confirmed(code === 'persist-failed' ? 'Locked, but the helper could not save it, so it will be lost on restart.' : undefined);
      }
      const present = await holds();
      if (present === null) return unconfirmed();
      if (!present) return rollback('The helper did not receive it.');
      return confirmed();
    });
  }

  // Shared shape of the four lock requests: find the live locked block by the key given, ask the helper.
  function lockRequest(blockKey, expectType, call, done) {
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
      if (!res || res.type !== expectType) {
        return { ok: false, message: 'The helper sent an unexpected reply. The lock is unchanged as far as we can tell. Refresh and try again.' };
      }
      await pollAndReconcile();
      changed();
      return done(res, windowId);
    });
  }

  function requestPartnerChallenge(blockKey) {
    return lockRequest(blockKey, 'Challenge', (id) => client.requestChallenge(id), (res) => (
      res && typeof res.code === 'string' && res.code
        ? { ok: true, code: res.code }
        : { ok: false, message: 'The helper sent an unreadable reply. Try again.' }));
  }

  function submitPartnerToken(blockKey, token) {
    if (typeof token !== 'string' || token.trim() === '' || token.length > 4096) {
      return Promise.resolve({ ok: false, message: describeUnlockError({ code: 'bad-format' }) });
    }
    return lockRequest(blockKey, 'Ok', () => client.submitToken(token.trim()), () => ({ ok: true }));
  }

  function startDelayedUnlock(blockKey) {
    return lockRequest(blockKey, 'UnlockPending', (id) => client.requestDelayedUnlock(id), (res, id) => {
      const at = res && Number.isFinite(res.unlock_at) ? res.unlock_at : pendingUnlockFor(helper.status, id);
      return at == null
        ? { ok: false, message: 'The helper sent an unreadable reply. Try again.' }
        : { ok: true, unlockAt: at };
    });
  }

  function cancelDelayedUnlock(blockKey) {
    return lockRequest(blockKey, 'Ok', (id) => client.cancelDelayedUnlock(id), () => ({ ok: true }));
  }

  function setPartner(input) {
    return enqueue(async () => {
      const { publicKey, name } = input || {};
      const key = typeof publicKey === 'string' ? publicKey.trim() : '';
      const nm = typeof name === 'string' ? name.trim() : '';
      if (!key || key.length > 1024) return { ok: false, message: describeUnlockError({ code: 'bad-key' }) };
      if (!nm || nm.length > 60) return { ok: false, message: 'Enter your partner\'s name (up to 60 characters).' };
      let warning = null;
      try {
        await client.setPartner(key);
      } catch (err) {
        if (err && err.code === 'persist-failed') {
          warning = 'The partner key is set, but the helper could not save it, so it will be lost on restart.';
        } else {
          return unreachable(err)
            ? { ok: false, message: 'Not sent. Your partner was not changed.' }
            : { ok: false, message: describeUnlockError(err) };
        }
      }
      try {
        await db.batch([
          { sql: 'DELETE FROM focus_partner' },
          { sql: 'INSERT INTO focus_partner(public_key, name) VALUES (?, ?)', params: [key, nm] },
        ]);
      } catch (e) {
        // The helper now has the new key; never keep showing the previous partner's name.
        try { await db.run('DELETE FROM focus_partner'); } catch { /* best effort */ }
        await reloadSafe();
        partnerName = null;
        await pollAndReconcile();
        changed();
        return { ok: false, message: `The helper accepted the key but its name could not be saved: ${errText(e)}.` };
      }
      await reloadSafe();
      await pollAndReconcile();
      changed();
      return warning ? { ok: true, message: warning } : { ok: true };
    });
  }

  /**
   * Usage rows for an inclusive day range. Runs OUTSIDE the write queue (a slow or absent helper must not
   * stall writes) and never throws. `down` is true when the helper could not be reached at all.
   */
  async function getUsage(fromDay, toDay) {
    try {
      const res = await client.getUsage(fromDay, toDay);
      if (!res || res.type !== 'Usage' || !Array.isArray(res.days)) {
        return { ok: false, down: false, message: 'The helper sent an unexpected reply.' };
      }
      return { ok: true, days: res.days };
    } catch (err) {
      let kind = 'unknown';
      try { kind = classifyHelperFailure(err).kind; } catch { /* keep unknown */ }
      const down = (err && err.code === 'unreachable') || ['not-running', 'timeout', 'unavailable'].includes(kind);
      return { ok: false, down: !!down, message: errText(err) };
    }
  }

  return {
    get state() {
      return {
        loaded, lists, schedules, blocks: allBlocks(now()), helper, syncPending, lastSync, notice,
        partner: { set: partnerSet, name: partnerSet ? partnerName : null },
      };
    },
    load, saveList, deleteList, saveSchedule, setScheduleEnabled, deleteSchedule, startBlock, extendBlock, cancelBlock, refreshStatus, resync,
    getUsage, startLockedBlock, setPartner, requestPartnerChallenge, submitPartnerToken, startDelayedUnlock, cancelDelayedUnlock,
  };
}
