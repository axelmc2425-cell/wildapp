// Runs one screen at a time. Screens may be async and return a cleanup function; this makes sure the
// previous screen's cleanup always runs, and that a slow render that finishes after the user moved on is cleaned up at once.
export function createRouteRunner() {
  let token = 0;
  let cleanup = null;
  const call = (fn) => { try { fn(); } catch { /* a failing cleanup must not block navigation */ } };
  return {
    async run(renderFn) {
      const mine = ++token;
      if (typeof cleanup === 'function') call(cleanup);
      cleanup = null;
      let result;
      try {
        result = await renderFn();
      } catch (e) {
        if (mine === token) throw e;
        return;
      }
      if (typeof result !== 'function') return;
      if (mine !== token) call(result);
      else cleanup = result;
    },
  };
}
