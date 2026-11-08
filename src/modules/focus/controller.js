import { DEFAULTS, initial, start, pause, tick, skip, reset, remaining } from './timer.js';
import { logSession } from './repo.js';

// Owns the running timer so it keeps going (and logs) even when the Focus screen is not open.
export function createController({ db, settings = DEFAULTS, now = Date.now }) {
  let state = initial(settings);
  let task = '';
  let phaseStartedAt = null;
  const listeners = new Set();
  const emit = (e) => listeners.forEach(fn => fn(e));

  return {
    state: () => state,
    task: () => task,
    remaining: () => remaining(state, now()),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setSettings(s) { settings = s; state = initial(s); phaseStartedAt = null; emit({ type: 'changed' }); },
    start(newTask) {
      if (newTask !== undefined) task = newTask;
      if (state.status === 'idle') phaseStartedAt = now();
      state = start(state, now());
      emit({ type: 'changed' });
    },
    pause() { state = pause(state, now()); emit({ type: 'changed' }); },
    reset() { state = reset(state); phaseStartedAt = null; emit({ type: 'changed' }); },
    skip() { state = skip(state); phaseStartedAt = null; emit({ type: 'changed' }); },
    async tick() {
      const r = tick(state, now());
      if (!r.finished) return null;
      state = r.state;
      if (r.finished.phase === 'work') {
        await logSession(db, { started: phaseStartedAt ?? now(), minutes: r.finished.minutes, task });
      }
      phaseStartedAt = null;
      emit({ type: 'finished', phase: r.finished.phase, minutes: r.finished.minutes });
      return r.finished;
    },
  };
}
