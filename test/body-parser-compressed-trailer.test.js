import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

// Local child only: large compressed trailers cross stream chunks after the
// small, valid JSON frame has finished. No live Orkestr endpoint is contacted.
test('a completed compressed JSON frame with trailing bytes cannot crash the parser process', {timeout: 10000}, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/body-parser-process.mjs', import.meta.url)),
    ...(process.env.ORKESTR_TEST_BODY_PARSER_PATH ? [process.env.ORKESTR_TEST_BODY_PARSER_PATH] : [])],
    {stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {PATH: process.env.PATH, NODE_ENV: 'test'}});
  let stderr = '', exited = false;
  child.stderr.on('data', data => {stderr += data;});
  child.once('exit', () => {exited = true;});
  t.after(async () => {
    if (exited) return;
    const done = once(child, 'exit');
    if (child.connected) child.send('stop'); else child.kill('SIGTERM');
    await done;
  });
  const [ready] = await once(child, 'message');
  const body = Buffer.concat([gzipSync(Buffer.from('{"ok":true}')), Buffer.of(0), Buffer.alloc(128 * 1024, 0x7f)]);
  const status = await new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port: ready.port, path: '/parse', method: 'POST', agent: false,
      headers: {'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length}}, result => {
      result.resume(); result.once('end', () => resolve(result.statusCode));
    });
    request.once('error', reject); request.end(body);
  });
  assert.equal(status, 200);
  // Decoder errors can arrive after the HTTP response; a successful response
  // alone is insufficient evidence that the process survived.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(exited, false, stderr);
  const response = await new Promise((resolve, reject) => {
    const request = http.get({host: '127.0.0.1', port: ready.port, path: '/alive', agent: false}, result => {
      result.resume(); result.once('end', () => resolve(result.statusCode));
    });
    request.once('error', reject);
  });
  assert.equal(response, 200);
  assert.equal(stderr, '');
});
