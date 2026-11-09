// Debounced saver that never drops text. Pending payloads are kept per note id (payload.id); a failed
// save stays pending and is retried. flush() resolves true only when everything has been saved.
export function createAutosaver({ save, delay = 600, retryDelay = 3000, onStatus = () => {} }) {
  const pending = new Map();
  let timer = null;
  let busy = null;
  let disposed = false;

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  // Saves one pending payload (and then the rest). Resolves false if a save failed.
  async function run() {
    if (disposed || busy || pending.size === 0) return true;
    const [id, payload] = pending.entries().next().value;
    pending.delete(id);
    onStatus('saving');
    busy = save(payload).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    const r = await busy;
    busy = null;
    if (!r.ok) {
      if (!pending.has(id)) pending.set(id, payload);
      onStatus('error', r.error);
      if (!disposed) schedule(retryDelay);
      return false;
    }
    if (pending.size > 0) return run();
    onStatus('saved');
    return true;
  }

  return {
    change(payload) {
      pending.set(payload.id ?? '_', payload);
      schedule(delay);
    },
    async flush() {
      clearTimeout(timer);
      for (;;) {
        if (busy) await busy;
        if (pending.size === 0) return true;
        if (!(await run())) return false;
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

// The text typed after an unclosed "[[" on the caret's line, or null.
export function wikiQuery(text, caret) {
  const before = text.slice(0, caret);
  const m = /\[\[([^\[\]\n]*)$/.exec(before);
  return m ? { start: m.index, query: m[1] } : null;
}

export function applyCompletion(text, caret, title) {
  const q = wikiQuery(text, caret);
  if (!q) return { text, caret };
  const head = text.slice(0, q.start) + '[[' + title + ']]';
  return { text: head + text.slice(caret), caret: head.length };
}
