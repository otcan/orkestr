// Only this Popen-owned bridge may start/stop the isolated ordinary server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function deadline(promise, milliseconds, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(code)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

export class WorkerFixture {
  constructor({ artifact, source, mode, output }) {
    this.next = 1;
    this.pending = new Map();
    this.closed = null;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    const stderr = fs.openSync(`${output}/fixture-stderr.log`, 'wx', 0o600);
    this.child = spawn('/usr/bin/python3', ['-B', '-s', fileURLToPath(new URL('./worker-fixture.py', import.meta.url)),
      artifact.server.path, artifact.ui.path, source, mode], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', stderr],
    });
    fs.closeSync(stderr);
    this.exit = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        const error = Error('fixture_exited');
        this.rejectReady(error);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        resolve({ code, signal });
      });
      this.child.once('error', () => { this.rejectReady(Error('fixture_launch_failed')); resolve({ code: null }); });
    });
    let pending = '', total = 0;
    this.child.stdout.on('data', bytes => {
      total += bytes.length;
      pending += bytes.toString('utf8');
      if (pending.length > 65536 || total > 1024 * 1024) return this.fail('fixture_output_bound');
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const item = JSON.parse(line);
          if (item.ready === true) this.resolveReady(item);
          else if (item.closed === true) this.closed = item;
          else if (item.error) this.fail('fixture_operation_failed');
          else {
            const request = this.pending.get(item.id);
            assert(request, 'unexpected_fixture_reply');
            this.pending.delete(item.id); request.resolve(item.value);
          }
        } catch { this.fail('invalid_fixture_reply'); }
      }
    });
  }
  fail(code) {
    this.rejectReady(Error(code));
    for (const item of this.pending.values()) item.reject(Error(code));
    this.pending.clear();
    this.child.kill('SIGTERM'); // Python's handler performs its bounded finally cleanup.
  }
  async request(method, name) {
    assert(this.child.exitCode === null && this.child.signalCode === null, 'fixture_not_running');
    assert(this.pending.size < 4, 'fixture_request_bound');
    const id = this.next++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ id, method, ...(name ? { name } : {}) })}\n`);
    try { return await deadline(result, 10000, 'fixture_operation_deadline'); }
    finally { this.pending.delete(id); }
  }
  async stop() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end(`${JSON.stringify({ id: this.next++, method: 'close' })}\n`);
    }
    let exit;
    try { exit = await deadline(this.exit, 15000, 'fixture_cleanup_deadline'); }
    catch {
      this.child.kill('SIGTERM');
      exit = await deadline(this.exit, 12000, 'fixture_cleanup_unconfirmed');
    }
    assert.equal(exit.code, 0, 'fixture_cleanup_failed');
    assert(this.closed?.cleanup?.servers_gone && this.closed.cleanup.native_identities_gone
      && this.closed.cleanup.synthetic_state_removed, 'fixture_cleanup_receipt_missing');
    return this.closed;
  }
}
