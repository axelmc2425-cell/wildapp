// Keeps the helper's 30-day window push fresh without the Focus Room page being open.
const SIX_HOURS = 6 * 3600000;
const ONE_HOUR = 3600000;

/**
 * Re-pushes about every 6 hours, and when the window regains focus after the last sync is over an
 * hour old. Idempotent per controller; errors are swallowed. Returns a stop function.
 * @param {{ resync: () => Promise<unknown>, state: { lastSync: unknown } }} controller
 */
export function startAutoResync(controller, {
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = () => Date.now(),
  target = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  everyMs = SIX_HOURS, staleMs = ONE_HOUR,
} = {}) {
  if (started.has(controller)) return started.get(controller);
  let last = now(); // the app start's own load() just pushed
  const run = () => {
    last = now();
    try { Promise.resolve(controller.resync()).catch(() => {}); } catch { /* never break the host */ }
  };
  const onWake = () => {
    if (doc && doc.visibilityState === 'hidden') return;
    if (now() - last >= staleMs) run();
  };
  const timer = setIntervalFn(run, everyMs);
  try { timer?.unref?.(); } catch { /* the timer must never keep a process alive */ }
  try { target?.addEventListener?.('focus', onWake); } catch { /* ignore */ }
  try { doc?.addEventListener?.('visibilitychange', onWake); } catch { /* ignore */ }
  const stop = () => {
    started.delete(controller);
    try { clearIntervalFn(timer); } catch { /* ignore */ }
    try { target?.removeEventListener?.('focus', onWake); } catch { /* ignore */ }
    try { doc?.removeEventListener?.('visibilitychange', onWake); } catch { /* ignore */ }
  };
  started.set(controller, stop);
  return stop;
}
const started = new WeakMap();
