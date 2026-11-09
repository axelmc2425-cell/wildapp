// Pomodoro state machine driven by timestamps (ms), so it stays right across sleep and throttled timers.
export const DEFAULTS = { work: 25, short: 5, long: 15, longEvery: 4, goal: 120 }; // goal: focus minutes per day, 0 = off
const MIN = 60000;

export function phaseMinutes(phase, settings) {
  return settings[phase];
}

function idleState(phase, completedWork, settings) {
  return { phase, completedWork, status: 'idle', remainingMs: phaseMinutes(phase, settings) * MIN, endsAt: null, settings };
}

export function initial(settings = DEFAULTS) {
  return idleState('work', 0, settings);
}

export function remaining(state, now) {
  return state.status === 'running' ? Math.max(0, state.endsAt - now) : state.remainingMs;
}

// Time spent in the current phase so far (ms), however many pauses it had.
export function elapsed(state, now) {
  return phaseMinutes(state.phase, state.settings) * MIN - remaining(state, now);
}

export function start(state, now) {
  if (state.status === 'running') return state;
  return { ...state, status: 'running', endsAt: now + state.remainingMs };
}

export function pause(state, now) {
  if (state.status !== 'running') return state;
  return { ...state, status: 'paused', remainingMs: Math.max(0, state.endsAt - now), endsAt: null };
}

function next(state) {
  const { settings } = state;
  if (state.phase === 'work') {
    const done = state.completedWork + 1;
    return idleState(done % settings.longEvery === 0 ? 'long' : 'short', done, settings);
  }
  return idleState('work', state.completedWork, settings);
}

export function skip(state) {
  return next(state);
}

// Returns { state, finished }: finished is { phase, minutes } when the running phase has ended.
export function tick(state, now) {
  if (state.status !== 'running' || now < state.endsAt) return { state, finished: null };
  return { state: next(state), finished: { phase: state.phase, minutes: phaseMinutes(state.phase, state.settings) } };
}

// Apply new lengths. An idle timer picks them up for its current phase straight away.
export function withSettings(state, settings) {
  return { ...state, settings, remainingMs: state.status === 'idle' ? phaseMinutes(state.phase, settings) * MIN : state.remainingMs };
}

export function reset(state) {
  return idleState(state.phase, state.completedWork, state.settings);
}
