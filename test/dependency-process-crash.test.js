import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/dependency-crash-process.mjs', import.meta.url));
const undici6 = fileURLToPath(new URL('../node_modules/node-gyp/node_modules/undici/index.js', import.meta.url));

for (const [label, kind, modulePath] of [
  ['late multipart filter', 'multer', process.env.ORKESTR_TEST_MULTER_PATH],
  ['undici 7 truncated excessive encoding', 'undici', process.env.ORKESTR_TEST_UNDICI7_PATH],
  ['undici 6 truncated excessive encoding', 'undici', process.env.ORKESTR_TEST_UNDICI6_PATH || undici6],
]) {
  test(`${label} cannot crash its isolated process`, () => {
    const result = spawnSync(process.execPath, [fixture, '--isolated', kind, ...(modulePath ? [modulePath] : [])],
      {timeout: 6000, encoding: 'utf8', env: {PATH: process.env.PATH, ORKESTR_DEPENDENCY_CRASH_FIXTURE: '1'}});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {survived: true, kind});
  });
}

test('the isolated fixture exits inert under direct test discovery', () => {
  const result = spawnSync(process.execPath, [fixture], {timeout: 2000, encoding: 'utf8', env: {PATH: process.env.PATH}});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, '');
});
