// Focus Room UI controller: owns state, serializes every write, and keeps the helper in sync.
import * as store from './store.js';
import { groupSessions, parseDuration, classifyHelperFailure, describePushProblem } from './model.js';
import { syncWindows } from './sync.js';

const MIN = 60000;
const MAX_MINUTES = 1440;
const PUSH_REJECTION_CODES = new Set(['bad-window', 'too-many', 'allow-needs-apps', 'frozen-unavailable']);
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
  return { pushWindows: fail, status: fail };
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

  const changed = () => { try { onChange?.(); } catch { /* UI callback must not break the controller */ } };

  // ONE queue for every write and every push, so store id read-backs see a single writer.
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.then(() => undefined, () => undefined);
    return p;
  };

  async function reload() {
    lists = await store.listLists(db);
    sessions = await store.listSessions(db);
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

  async function refreshStatus() {
    const mine = ++seq;
    try {
      const status = await client.status();
      if (mine === seq && !syncPending) helper = { kind: 'ok', status };
    } catch (err) {
      if (mine === seq) {
        try { helper = classifyHelperFailure(err); } catch { helper = { kind: 'unknown', message: 'Unknown error' }; }
      }
    }
    changed();
  }

  // Runs inside the queue. Returns true when the helper accepted the push.
  async function doResync() {
    try {
      lastSync = await syncWindows(db, client, now(), tzOffsetAt);
      syncPending = false;
      notice = null;
      await refreshStatus();
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
        changed();
      } catch (e) {
        notice = `Could not read your focus data: ${errText(e)}`;
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
        res = await store.saveList(db, input);
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

  function startBlock({ listIds, minutes } = {}) {
    return enqueue(async () => {
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
        const cap = block.starts + MAX_MINUTES * MIN;
        if (block.ends >= cap) return { ok: false, message: 'A block can be at most 24 hours long.' };
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

  return {
    get state() {
      return { lists, blocks: groupSessions(sessions, lists, now()), helper, syncPending, lastSync, notice };
    },
    load, saveList, deleteList, startBlock, extendBlock, cancelBlock, refreshStatus, resync,
  };
}
