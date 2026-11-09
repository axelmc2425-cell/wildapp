import { DEFAULTS, initial, start, pause, tick, skip, reset, remaining, elapsed, withSettings } from './timer.js';

const MIN = 60000;
import { logSession } from './repo.js';

// Owns the running timer so it keeps going (and logs) even when the Focus screen is not open.
export function createController({ db, settings = DEFAULTS, now = Date.now }) {
  let state = initial(settings);
  let task = '';
  let phaseStartedAt = null;
  let queued = null; // new lengths wait here until the current session ends
  const unsaved = []; // finished sessions that could not be written yet; retried on every tick
  const listeners = new Set();
  const emit = (e) => listeners.forEach(fn => fn(e));

  function applyQueued() {
    if (!queued) return;
    state = withSettings(state, queued);
    queued = null;
  }

  // Takes an entry off the queue before writing it, so overlapping flushes never write the same one twice.
  async function flushUnsaved() {
    while (unsaved.length) {
      const entry = unsaved.shift();
      try { await logSession(db, entry); } catch { unsaved.unshift(entry); return; }
      emit({ type: 'saved' });
    }
  }

  // Stopping a focus phase early keeps the time as an unfinished session (shown in the log, not in the stats).
  function keepPartial() {
    if (state.phase !== 'work') return;
    const minutes = Math.floor(elapsed(state, now()) / MIN);
    if (minutes < 1) return;
    unsaved.push({ started: phaseStartedAt ?? now(), minutes, task, completed: 0 });
    void flushUnsaved();
  }

  return {
    state: () => state,
    task: () => task,
    remaining: () => remaining(state, now()),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setSettings(s) {
      if (state.status === 'idle') { state = withSettings(state, s); queued = null; } else queued = s;
      emit({ type: 'changed' });
    },
    start(newTask) {
      if (newTask !== undefined) task = newTask;
      if (state.status === 'idle') phaseStartedAt = now();
      state = start(state, now());
      emit({ type: 'changed' });
    },
    pause() { state = pause(state, now()); emit({ type: 'changed' }); },
    reset() { keepPartial(); state = reset(state); phaseStartedAt = null; applyQueued(); emit({ type: 'changed' }); },
    skip() { keepPartial(); state = skip(state); phaseStartedAt = null; applyQueued(); emit({ type: 'changed' }); },
    async tick() {
      await flushUnsaved();
      const r = tick(state, now());
      if (!r.finished) return null;
      state = r.state;
      const started = phaseStartedAt ?? now();
      phaseStartedAt = null;
      applyQueued();
      if (r.finished.phase === 'work') {
        const entry = { started, minutes: r.finished.minutes, task };
        try { await logSession(db, entry); } catch (error) { unsaved.push(entry); emit({ type: 'error', error }); }
      }
      emit({ type: 'finished', phase: r.finished.phase, minutes: r.finished.minutes });
      return r.finished;
    },
  };
}
