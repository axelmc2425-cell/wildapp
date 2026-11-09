const ORDER = ['secondbrain', 'focus', 'cooking', 'money', 'skills', 'photos', 'journal'];
const registry = new Map();

export function registerModule(def) {
  if (registry.has(def.id)) throw new Error('duplicate module: ' + def.id);
  registry.set(def.id, def);
  if (def.searchProvider) {
    import('../core/search.js').then(s => s.registerSearchProvider(def.id, def.searchProvider));
  }
}

export function listModules() {
  const rank = (id) => { const i = ORDER.indexOf(id); return i < 0 ? ORDER.length : i; };
  return [...registry.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

export function getModule(id) {
  return registry.get(id) || null;
}

/**
 * Runs every module's optional onStart(ctx) in module order; one failure never stops the rest.
 * A hook still running after timeoutMs is left running in the background and the next one starts.
 */
export async function runStartHooks(ctx, { timeoutMs = 3000 } = {}) {
  for (const m of listModules()) {
    if (typeof m.onStart !== 'function') continue;
    let timer;
    try {
      const hook = Promise.resolve().then(() => m.onStart(ctx));
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => {
          console.error('onStart for ' + m.id + ' is still running; continuing');
          resolve();
        }, timeoutMs);
      });
      // Late failures of an abandoned hook are logged here, never unhandled.
      const guarded = hook.catch((e) => { console.error('module start hook failed: ' + m.id, e); });
      await Promise.race([guarded, timedOut]);
    } catch (e) {
      console.error('module start hook failed: ' + m.id, e);
    } finally {
      clearTimeout(timer);
    }
  }
}
