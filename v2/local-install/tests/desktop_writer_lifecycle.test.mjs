import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { createDesktopWriterLifecycle } from '../desktop_writer_lifecycle.mjs';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('drain blocks all lease access and retained ports use new factory', async () => {
  const held = deferred();
  const calls = [];
  const lifecycle = createDesktopWriterLifecycle(() => ({ acquire: async () => {
    calls.push('old'); await held.promise; return 'finished-old';
  }, readAll: () => [] }));
  const port = lifecycle.port({ synthetic: true });
  const old = port.acquire();
  const drain = lifecycle.pauseAndDrain();
  await assert.rejects(port.readAll(), /desktop_writer_paused/);
  await assert.rejects(port.heartbeat(), /desktop_writer_paused/);
  assert.equal(lifecycle.status().active, 1);
  held.resolve();
  assert.equal(await old, 'finished-old');
  const token = await drain;
  await lifecycle.adopt(token, () => ({ acquire: () => 'new' }), async (factory) => {
    assert.equal(lifecycle.status().state, 'adopting');
    await assert.rejects(port.acquire(), /desktop_writer_paused/);
    assert.equal(factory().acquire(), 'new');
  });
  assert.equal(await port.acquire(), 'new');
  assert.deepEqual(calls, ['old']);
  await assert.rejects(lifecycle.adopt(token, () => ({}), async () => {}), /token_invalid/);
});

test('timeout stays paused, never cancels old operation; explicit retry drains', async () => {
  const held = deferred();
  const lifecycle = createDesktopWriterLifecycle(() => ({ release: () => held.promise }));
  const old = lifecycle.port({}).release();
  await assert.rejects(lifecycle.pauseAndDrain({ timeoutMs: 5 }), /still_paused/);
  await assert.rejects(lifecycle.port({}).acquire(), /paused/);
  held.resolve('completed');
  assert.equal(await old, 'completed');
  const token = await lifecycle.pauseAndDrain();
  await lifecycle.adopt(token, () => ({}), async () => {});
  assert.equal(lifecycle.status().state, 'open');
});

test('adoption uncertainty poisons dispatch; old factory never revived', async () => {
  const lifecycle = createDesktopWriterLifecycle(() => ({ acquire: () => assert.fail('old writer') }));
  const token = await lifecycle.pauseAndDrain();
  await assert.rejects(lifecycle.adopt(token, () => ({}), async () => { throw Error('uncertain'); }), /uncertain/);
  assert.equal(lifecycle.status().state, 'poisoned');
  await assert.rejects(lifecycle.port({}).acquire(), /paused/);
  await assert.rejects(lifecycle.pauseAndDrain(), /unavailable/);
});

test('rejected old operation drains; forged token and concurrent transitions refuse', async () => {
  const lifecycle = createDesktopWriterLifecycle(() => ({ acquire: () => { throw Error('old failed'); } }));
  await assert.rejects(lifecycle.port({}).acquire(), /old failed/);
  const token = await lifecycle.pauseAndDrain();
  await assert.rejects(lifecycle.adopt({}, () => ({}), async () => {}), /token_invalid/);
  await assert.rejects(lifecycle.pauseAndDrain(), /unavailable/);
  await lifecycle.adopt(token, () => ({}), async () => {});
  assert.equal(lifecycle.status().active, 0);
});

test('owned synthetic stdio child stays same PID and responsive through handoff', async (t) => {
  // No provider, account or application process. Cleanup signals only this child.
  const child = spawn(process.execPath, ['-e',
    "process.stdin.setEncoding('utf8'); process.stdin.on('data', x => process.stdout.write(x));"],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await ended; });
  const lines = readline.createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const ping = async (word) => {
    const response = once(lines, 'line');
    child.stdin.write(word + '\n');
    assert.equal((await response)[0], word);
    assert.equal(child.exitCode, null);
  };
  await ping('before');
  const pid = child.pid;
  const lifecycle = createDesktopWriterLifecycle(() => ({ readAll: () => [] }));
  const token = await lifecycle.pauseAndDrain();
  await ping('paused');
  await lifecycle.adopt(token, () => ({ readAll: () => ['new'] }), async () => {
    await ping('adopting');
  });
  await ping('after');
  assert.equal(child.pid, pid);
  assert.deepEqual(await lifecycle.port({}).readAll(), ['new']);
});
