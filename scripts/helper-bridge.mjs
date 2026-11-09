// Talks to `focus-helper stdio` over a child process: one JSON line in, one JSON line out.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createStdioCall(binPath, statePath) {
  const child = spawn(binPath, ['stdio', '--state', statePath], { stdio: ['pipe', 'pipe', 'inherit'] });
  let dead = null; // Error once the child is gone
  let waiter = null; // { resolve, reject } for the in-flight call
  const exited = new Promise((res) => child.once('close', res));

  const fail = (err) => {
    if (dead) return;
    dead = err;
    if (waiter) { const w = waiter; waiter = null; w.reject(err); }
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (waiter) { const w = waiter; waiter = null; w.resolve(line); }
  });
  child.on('error', (e) => fail(new Error('helper failed: ' + e.message)));
  // 'close' fires after stdout is drained, so a last reply is never lost to an early 'exit'.
  child.on('close', (code, sig) => fail(new Error(`helper exited (${sig || code})`)));
  child.stdin.on('error', (e) => fail(new Error('helper stdin closed: ' + e.message)));

  let chain = Promise.resolve();
  const callOne = (requestLine) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    waiter = { resolve, reject };
    child.stdin.write(requestLine + '\n', (e) => { if (e) fail(new Error('helper write failed: ' + e.message)); });
  });

  return {
    get pid() { return child.pid; },
    call(requestLine) {
      const p = chain.then(() => callOne(requestLine));
      chain = p.catch(() => {});
      return p;
    },
    async close() {
      fail(new Error('helper closed'));
      try { child.stdin.end(); } catch { /* already closed */ }
      child.kill();
      await exited;
    },
  };
}
