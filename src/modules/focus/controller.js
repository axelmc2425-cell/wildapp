import { DEFAULTS, initial, start, pause, tick, skip, reset, remaining, withSettings } from './timer.js';
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

  async function flushUnsaved() {
    while (unsaved.length) {
      try { await logSession(db, unsaved[0]); } catch { return; }
      unsaved.shift();
      emit({ type: 'saved' });
    }
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
    reset() { state = reset(state); phaseStartedAt = null; applyQueued(); emit({ type: 'changed' }); },
    skip() { state = skip(state); phaseStartedAt = null; applyQueued(); emit({ type: 'changed' }); },
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
