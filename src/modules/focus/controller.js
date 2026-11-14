// Focus Room UI controller: owns state, serializes every write, and keeps the helper in sync.
import * as store from './store.js';
import { groupSessions, parseDuration, classifyHelperFailure, describePushProblem } from './model.js';
import { syncWindows } from './sync.js';
import { scheduleBlocks, nextOccurrence } from './schedule-logic.js';
import { makeTzOffsetAt } from './tz.js';
import { describeUnlockError, windowIdForBlock, pendingUnlockFor, resolveDelayHours } from './lock-logic.js';
import { validateLimit, isWeakening } from './limit-logic.js';
import { syncLimits, fromWire, limitDiffers } from './limit-sync.js';

const MIN = 60000;
const MAX_MINUTES = 1440;
const PUSH_REJECTION_CODES = new Set(['bad-window', 'too-many', 'allow-needs-apps', 'frozen-unavailable']);
const LIMIT_REJECTION_CODES = new Set(['bad-limit', 'no-partner']);
const LIMIT_KEY_RE = /^limit-\d+$/;
const LIMIT_REASONS = [
  ['bad-name', 'name', 'Give the limit a name up to 64 characters.'],
  ['no-items', 'items', 'Add at least one app or site.'],
  ['too-many-items', 'items', 'A limit can hold up to 100 apps and sites.'],
  ['bad-item', 'items', 'One of the apps or sites is not valid.'],
  ['bad-cap', 'cap', 'The helper did not accept that time. Choose between 1 minute and 24 hours (168 hours for weekly).'],
  ['bad-delay', 'delay', 'Choose a wait between 1 hour and 7 days.'],
  ['bad-lock', 'delay', 'Choose a wait between 1 hour and 7 days.'],
];
const LIMIT_PARTNER_MSG = "Add your partner's key first, so someone else can end a locked limit early if you need.";
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
    requestDelayedUnlock: fail, cancelDelayedUnlock: fail, getUsage: fail, getSessions: fail,
    pushLimits: fail, getLimits: fail,
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
  let limits = [];
  let limitStatus = new Map();
  let limitPending = [];
  let limitsLoaded = false;
  let limitEnforcement = false;
  let limitsEverPushed = false;
  let reconciling = false;
  let limitsUnsent = false; // a limits push failed; window pushes track syncPending

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
    limits = await store.listLimits(db);
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
      if (mine === seq && !syncPending && !limitsUnsent) { helper = { kind: 'ok', status }; applied = status; }
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
    let stage = 'windows';
    try {
      lastSync = await syncWindows(db, client, now(), tzOffsetAt);
      stage = 'limits';
      const lim = await syncLimits(db, client, { force: limitsEverPushed });
      if (lim && lim.pushed > 0) limitsEverPushed = true;
      syncPending = false;
      limitsUnsent = false;
      notice = null;
      await afterLimitPush(lim);
      if (limits.length > 0) await applyLimitsRes(await fetchLimits());
      await pollAndReconcile();
      changed();
      return true;
    } catch (err) {
      if (stage === 'windows') syncPending = true; else limitsUnsent = true;
      seq++;
      try { helper = classifyHelperFailure(err); } catch { helper = { kind: 'unknown', message: 'Unknown error' }; }
      try {
        notice = err && PUSH_REJECTION_CODES.has(err.code)
          ? describePushProblem(err, lastSync?.skipped ?? 0, lists.map((l) => l.name))
          : stage === 'limits' && err && LIMIT_REJECTION_CODES.has(err.code) ? limitRejectNotice(err) : null;
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
      const ok = await doResync();
      if (!ok || limits.length === 0) await applyLimitsRes(ok ? await fetchLimits() : null);
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


  // ---- time limits ----
  const limitName = (wid) => {
    const l = limits.find((x) => `limit-${x.id}` === wid);
    return l ? l.name : wid;
  };

  function limitRejectNotice(err) {
    if (err && err.code === 'no-partner') return LIMIT_PARTNER_MSG;
    return `The helper did not accept a time limit (${errText(err)}). Open the limit and check it.`;
  }

  function limitRejectErrors(err) {
    if (err && err.code === 'no-partner') return { form: LIMIT_PARTNER_MSG };
    const msg = errText(err);
    const errors = {};
    for (const [reason, field, text] of LIMIT_REASONS) if (msg.includes(reason)) errors[field] = text;
    return Object.keys(errors).length ? errors : { form: `The helper did not accept the limit (${msg}).` };
  }

  // Marks the helper state from a failed push, like a failed window push does.
  function markDown(err) {
    limitsUnsent = true;
    seq++;
    try { helper = classifyHelperFailure(err); } catch { helper = { kind: 'unknown', message: 'Unknown error' }; }
    changed();
  }

  // Runs inside the queue. Result of a limits push: ok (reply or null), rejected or failed.
  async function pushLimitsOutcome() {
    try {
      const r = await syncLimits(db, client, { force: limitsEverPushed });
      if (r && r.pushed > 0) limitsEverPushed = true;
      limitsUnsent = false;
      return { kind: 'ok', r };
    } catch (err) {
      return { kind: LIMIT_REJECTION_CODES.has(err && err.code) ? 'rejected' : 'failed', err };
    }
  }

  async function fetchLimits() {
    try {
      const res = await client.getLimits();
      if (!res || res.type !== 'Limits' || !Array.isArray(res.limits)) return null;
      return res;
    } catch { return null; }
  }

  // Runs inside the queue. Applies a GetLimits answer (null: helper not answering) to the state, and lets
  // the helper's copy of a locked limit win over the app row (kept_locked, or an unlock that finished).
  async function applyLimitsRes(res) {
    limitsLoaded = true;
    if (!res) {
      limitEnforcement = false;
      limitStatus = new Map();
      changed();
      return;
    }
    limitEnforcement = true;
    limitStatus = new Map((Array.isArray(res.status) ? res.status : []).filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
    limitPending = Array.isArray(res.pending_unlocks) ? res.pending_unlocks : [];
    if (!limitsUnsent && !reconciling) {
      reconciling = true;
      try {
        let adopted = false;
        for (const row of limits) {
          const h = res.limits.find((x) => x && x.id === `limit-${row.id}`);
          if (!h) continue;
          const helperLocked = h.lock === 'locked';
          if ((helperLocked || row.lock === 'locked') && limitDiffers(row, h)) {
            try {
              await store.saveLimit(db, { ...fromWire(h), id: row.id, enabled: helperLocked ? true : row.enabled });
              adopted = true;
            } catch { /* retried on the next refresh */ }
          }
        }
        // A locked limit the helper holds but the app has no row for: bring it back so it can be shown and unlocked.
        for (const h of res.limits) {
          const m = h && typeof h.id === 'string' ? /^limit-(\d+)$/.exec(h.id) : null;
          if (!m || h.lock !== 'locked' || limits.some((r) => r.id === Number(m[1]))) continue;
          try {
            await store.saveLimit(db, { ...fromWire(h), id: Number(m[1]), enabled: true }, { adopt: true });
            adopted = true;
          } catch { /* retried on the next refresh */ }
        }
        // An empty app list with limits still on the helper (restart after a wipe): a push clears stale unlocked ones.
        const staleHelper = limits.length === 0 && res.limits.length > 0;
        if (adopted) await reloadSafe();
        if (adopted || staleHelper) {
          if (staleHelper) limitsEverPushed = true;
          const out = await pushLimitsOutcome();
          if (out.kind === 'ok') await afterLimitPush(out.r);
          else markDown(out.err);
        }
      } finally { reconciling = false; }
    }
    changed();
  }

  // Runs inside the queue, right after a successful limits push.
  async function afterLimitPush(r) {
    if (!r) return;
    const kept = r.keptLocked;
    const tomb = r.skippedTombstoned;
    if (kept.length) {
      await reloadSafe();
      await applyLimitsRes(await fetchLimits());
    }
    if (!syncPending && !limitsUnsent) notice = null;
    const parts = [];
    for (const id of kept) parts.push(`${limitName(id)} is locked and was kept.`);
    for (const id of tomb) parts.push(`The lock on ${limitName(id)} was not re-applied because its unlock is still being synced. It will be retried on the next sync.`);
    if (parts.length) notice = parts.join(' ');
    changed();
  }

  // For flows where a failed push is not fatal (delete, pause, unlock): settle and say what happened.
  async function settleLimitPush(out) {
    if (out.kind === 'ok') { await afterLimitPush(out.r); return null; }
    if (out.kind === 'rejected') {
      limitsUnsent = true;
      notice = limitRejectNotice(out.err);
      changed();
      return notice;
    }
    if (out.err && out.err.code === 'persist-failed') {
      return 'The helper could not save the change to disk, so it may be lost on restart.';
    }
    markDown(out.err);
    return "The helper couldn't be reached, so the change is not enforced yet. It will be sent again.";
  }

  const toLimitInput = (inp, id, enabled) => ({
    ...inp, id, enabled, unlockDelayMs: inp.lock === 'locked' ? inp.unlockDelayMs : null,
  });

  function saveLimit(input) {
    return enqueue(async () => {
      const inp = input && typeof input === 'object' ? input : {};
      const v = validateLimit(inp);
      if (!v.ok) return { ok: false, errors: v.errors };
      let existing = null;
      try {
        await reload();
        if (inp.id !== undefined && inp.id !== null) {
          existing = limits.find((l) => l.id === inp.id) || null;
          if (!existing) return { ok: false, errors: { form: 'That limit no longer exists.' } };
        }
      } catch (e) {
        return { ok: false, errors: { form: `Could not save: ${errText(e)}` } };
      }
      const prevLocked = !!existing && existing.lock === 'locked';
      if (prevLocked && inp.enabled === false) return { ok: false, needsUnlock: true, limitId: existing.id };
      const enabled = inp.lock === 'locked' ? true : inp.enabled === undefined ? (existing ? existing.enabled : true) : !!inp.enabled;
      const next = toLimitInput(inp, existing ? existing.id : undefined, enabled);
      if (prevLocked && isWeakening(existing, next)) return { ok: false, needsUnlock: true, limitId: existing.id };
      // A lock the helper has not accepted must not exist here: new locked limits (or locking an old one)
      // are saved only to get the id, and undone unless the helper takes them.
      const needsAccept = inp.lock === 'locked' && !prevLocked;
      let id;
      try {
        id = await store.saveLimit(db, next);
      } catch (e) {
        const msg = errText(e);
        if (/too many/.test(msg)) return { ok: false, errors: { form: 'You can have up to 64 limits.' } };
        if (msg === 'no such limit') return { ok: false, errors: { form: 'That limit no longer exists.' } };
        return { ok: false, errors: { form: `Could not save: ${msg.replace(/^invalid limit: /, '')}` } };
      }
      const wid = `limit-${id}`;
      await reloadSafe();
      changed();
      const undo = async () => {
        try {
          if (existing) await store.saveLimit(db, existing); else await store.deleteLimit(db, id);
        } catch { await reloadSafe(); changed(); return false; }
        await reloadSafe();
        changed();
        return true;
      };
      const undoFailed = () => {
        limitsUnsent = true;
        return { ok: false, errors: { form: 'The helper did not take the change, and the save could not be undone here. Reopen the Focus Room to check.' } };
      };
      const success = async (r, extra = {}) => {
        await afterLimitPush(r);
        await applyLimitsRes(await fetchLimits());
        return { ok: true, id, ...extra };
      };
      const out = await pushLimitsOutcome();
      if (out.kind === 'rejected') {
        if (!(await undo())) return undoFailed();
        await doResync();
        return { ok: false, errors: limitRejectErrors(out.err) };
      }
      if (out.kind === 'ok') {
        const r = out.r;
        if (r && r.keptLocked.includes(wid)) {
          await afterLimitPush(r);
          return { ok: false, needsUnlock: true, limitId: id };
        }
        if (needsAccept && r && r.skippedTombstoned.includes(wid)) {
          if (!(await undo())) return undoFailed();
          await doResync();
          return { ok: false, errors: { form: 'The helper is still finishing the earlier unlock of this limit. Try again in a moment.' } };
        }
        return success(r);
      }
      // The push failed without a clear answer.
      const err = out.err;
      if (err && err.code === 'persist-failed') {
        const msg = 'Saved, but the helper could not save it to disk, so it will be lost on restart.';
        return success(null, { unconfirmed: true, message: msg, warning: msg });
      }
      if (needsAccept) {
        // A timeout may still have applied: ask the helper before undoing.
        if (isTimeout(err)) {
          const res = await fetchLimits();
          const held = res ? res.limits.some((x) => x && x.id === wid && x.lock === 'locked') : null;
          if (held === true) return success(null);
          if (held === null) {
            markDown(err);
            const msg = "Couldn't confirm the lock with the helper. It may be on. Check the Focus Room.";
            return { ok: true, id, unconfirmed: true, message: msg, warning: msg };
          }
        }
        if (!(await undo())) return undoFailed();
        return { ok: false, message: `Nothing was saved. ${plainReason(err)}` };
      }
      markDown(err);
      const msg = "Saved, but the helper couldn't be reached, so the limit is not enforced yet. It will be sent again.";
      return { ok: true, id, unconfirmed: true, message: msg, warning: msg };
    });
  }

  function setLimitEnabled(id, enabled) {
    return enqueue(async () => {
      let row;
      try {
        await reload();
        row = limits.find((l) => l.id === id);
        if (!row) return { ok: false, reason: 'error', message: 'That limit no longer exists.' };
        if (row.lock === 'locked' && !enabled) return { ok: false, needsUnlock: true, limitId: id };
        if (row.enabled === !!enabled) return { ok: true };
        await store.setLimitEnabled(db, id, !!enabled);
      } catch (e) {
        return { ok: false, reason: 'error', message: `Could not save: ${errText(e)}` };
      }
      await reloadSafe();
      changed();
      const warning = await settleLimitPush(await pushLimitsOutcome());
      return warning ? { ok: true, unconfirmed: true, message: warning, warning } : { ok: true };
    });
  }

  function deleteLimit(id) {
    return enqueue(async () => {
      try {
        await reload();
        const row = limits.find((l) => l.id === id);
        if (!row) return { ok: false, reason: 'error', message: 'That limit no longer exists.' };
        // Only the helper can say a lock is over, and the app row may be stale: always ask it.
        const res = await fetchLimits();
        if (!res && row.lock === 'locked') return { ok: false, reason: 'error', message: "Not deleted. Couldn't reach the helper to check the lock." };
        const h = res ? res.limits.find((x) => x && x.id === `limit-${id}`) : null;
        if (h && h.lock === 'locked') return { ok: false, needsUnlock: true, limitId: id };
        await store.deleteLimit(db, id);
      } catch (e) {
        return { ok: false, reason: 'error', message: `Could not delete: ${errText(e)}` };
      }
      await reloadSafe();
      changed();
      const out = await pushLimitsOutcome();
      if (out.kind === 'ok' && out.r && out.r.keptLocked.includes(`limit-${id}`)) {
        await afterLimitPush(out.r); // adopts the helper's copy back as a row
        return { ok: false, needsUnlock: true, limitId: id };
      }
      const warning = await settleLimitPush(out);
      await applyLimitsRes(await fetchLimits());
      return warning ? { ok: true, helperStopped: false, message: warning, warning } : { ok: true, helperStopped: true };
    });
  }

  /** Fresh numbers from the helper. The call itself runs outside the write queue. */
  async function refreshLimits() {
    // Fetched inside the queue: a snapshot taken before a queued write must not be applied after it.
    await enqueue(async () => applyLimitsRes(await fetchLimits()), { quiet: true });
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
      const forLimit = typeof blockKey === 'string' && LIMIT_KEY_RE.test(blockKey);
      try {
        if (forLimit) {
          await reload();
          const row = limits.find((l) => `limit-${l.id}` === blockKey);
          block = row ? { lock: row.lock, windowId: blockKey } : null;
        } else {
          block = typeof blockKey === 'string' ? await findLiveBlock(blockKey) : null;
        }
      } catch (e) {
        return dbFail(e);
      }
      if (!block) return { ok: false, message: describeUnlockError({ code: 'no-such-lock' }) };
      if (block.lock !== 'locked') return { ok: false, message: forLimit ? 'That limit is not locked.' : 'That block is not locked.' };
      const windowId = forLimit ? blockKey : windowIdForBlock(block);
      let res;
      try {
        res = await call(windowId);
      } catch (err) {
        return requestFailure(err);
      }
      if (!res || res.type !== expectType) {
        return { ok: false, message: 'The helper sent an unexpected reply. The lock is unchanged as far as we can tell. Refresh and try again.' };
      }
      if (forLimit) await applyLimitsRes(await fetchLimits());
      else await pollAndReconcile();
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

  /** Focus stretches for one local day; same never-throws contract and result shape as getUsage. */
  async function getSessions(day) {
    try {
      const res = await client.getSessions(day);
      if (!res || res.type !== 'Sessions' || !Array.isArray(res.stretches)) {
        return { ok: false, down: false, message: 'The helper sent an unexpected reply.' };
      }
      return { ok: true, day: res.day ?? day, truncated: !!res.truncated, stretches: res.stretches };
    } catch (err) {
      let kind = 'unknown';
      try { kind = classifyHelperFailure(err).kind; } catch { /* keep unknown */ }
      const down = (err && err.code === 'unreachable') || ['not-running', 'timeout', 'unavailable'].includes(kind);
      const unavailable = kind === 'unavailable' || /desktop app/i.test(errText(err));
      return { ok: false, down: !!down, unavailable, code: err && err.code, message: errText(err) };
    }
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
      const unavailable = kind === 'unavailable' || /desktop app/i.test(errText(err));
      return { ok: false, down: !!down, unavailable, code: err && err.code, message: errText(err) };
    }
  }

  return {
    get state() {
      return {
        limitsState: {
          limits: limits.map((l) => ({ ...l, status: limitEnforcement ? limitStatus.get(`limit-${l.id}`) : undefined })),
          pendingUnlocks: limitPending,
          loaded: limitsLoaded,
          enforcement: limitEnforcement,
        },
        loaded, lists, schedules, blocks: allBlocks(now()), helper, syncPending: syncPending || limitsUnsent, lastSync, notice,
        partner: { set: partnerSet, name: partnerSet ? partnerName : null },
      };
    },
    saveLimit, setLimitEnabled, deleteLimit, refreshLimits,
    load, saveList, deleteList, saveSchedule, setScheduleEnabled, deleteSchedule, startBlock, extendBlock, cancelBlock, refreshStatus, resync,
    getUsage, getSessions, startLockedBlock, setPartner, requestPartnerChallenge, submitPartnerToken, startDelayedUnlock, cancelDelayedUnlock,
  };
}
