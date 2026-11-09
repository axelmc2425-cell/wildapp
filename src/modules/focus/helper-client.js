// Client for the Focus Room helper protocol (one JSON line in, one JSON line out).

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** @param {(json: string) => Promise<string>} call */
export function createHelperClient(call) {
  async function send(req) {
    let raw;
    try {
      raw = await call(JSON.stringify(req));
    } catch (e) {
      // Tauri rejects with a plain string; a pipe that is down or slow has no helper reply at all.
      throw fail(e instanceof Error ? e.message : String(e), 'unreachable');
    }
    let res;
    try {
      res = JSON.parse(raw);
    } catch {
      throw fail('The helper sent an unreadable reply', 'bad-response');
    }
    if (!res || typeof res !== 'object' || typeof res.type !== 'string') {
      throw fail('The helper sent an unreadable reply', 'bad-response');
    }
    if (res.type === 'Error') throw fail(String(res.message ?? res.code), res.code);
    return res;
  }
  return {
    pushWindows: (windows) => send({ type: 'PushWindows', windows }),
    status: () => send({ type: 'GetStatus' }),
    requestChallenge: (windowId) => send({ type: 'RequestChallenge', window_id: windowId }),
    submitToken: (token) => send({ type: 'SubmitToken', token }),
    setPartner: (publicKey) => send({ type: 'SetPartner', public_key: publicKey }),
    requestDelayedUnlock: (windowId) => send({ type: 'RequestDelayedUnlock', window_id: windowId }),
    cancelDelayedUnlock: (windowId) => send({ type: 'CancelDelayedUnlock', window_id: windowId }),
    /** Recovery from a bogus far-future clock; refused (`lock-active`) while any lock is pending. */
    resetClock: () => send({ type: 'ResetClock' }),
  };
}

/** `call` backed by the Tauri `focus_helper_call` command (Windows named pipe). */
export function createTauriHelperCall() {
  return (json) => window.__TAURI__.core.invoke('focus_helper_call', { request: json });
}
