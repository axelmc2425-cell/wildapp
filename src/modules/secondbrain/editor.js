// Debounced saver that never drops text: on failure it keeps the latest payload and retries.
export function createAutosaver({ save, delay = 600, retryDelay = 3000, onStatus = () => {} }) {
  let pending = null;
  let timer = null;
  let busy = null;
  let disposed = false;

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  async function run() {
    if (disposed || pending === null || busy) return;
    const payload = pending;
    pending = null;
    onStatus('saving');
    busy = save(payload).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    const r = await busy;
    busy = null;
    if (!r.ok) {
      if (pending === null) pending = payload;
      onStatus('error', r.error);
      if (!disposed) schedule(retryDelay);
      return;
    }
    if (pending !== null) await run();
    else onStatus('saved');
  }

  return {
    change(payload) {
      pending = payload;
      schedule(delay);
    },
    async flush() {
      clearTimeout(timer);
      if (busy) await busy;
      await run();
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
