import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AdditionCounter, historyAdditions} from '../scripts/security/secret-scan-statistics.mjs';
import {resolveScope, scanEnvironment, scannerLogOptions} from '../scripts/security/secret-scan-scope.mjs';

test('history metadata beyond one MiB is counted completely across bounded chunks', () => {
  const counter = new AdditionCounter();
  const row = Buffer.from('12\t3\t' + 'synthetic-path/'.repeat(80) + '\n');
  let bytes = 0;
  for (let n = 0; n < 2500; n++) {
    for (let at = 0; at < row.length; at += 17) counter.feed(row.subarray(at, at + 17));
    bytes += row.length;
  }
  assert.ok(bytes > 2 * 1024 * 1024);
  assert.equal(counter.finish(), 30000);
});

test('binary and deletion rows count no text additions; arbitrarily long paths are discarded', () => {
  const counter = new AdditionCounter();
  counter.feed(Buffer.from('-\t-\tbinary\n0\t99\tdeleted\n7\t0\t'));
  for (let n = 0; n < 128; n++) counter.feed(Buffer.alloc(65536, 120));
  counter.feed(Buffer.from('\n\n'));
  assert.equal(counter.finish(), 7);
});

test('malformed, truncated and unsafe numeric metadata fails closed', () => {
  for (const row of ['x\t1\tfile\n', '1\t', '1\n', '9007199254740992\t0\tfile\n', '1'.repeat(65)]) {
    assert.throws(() => {const counter = new AdditionCounter(); counter.feed(Buffer.from(row)); counter.finish();},
      /scan_revision_count_invalid/);
  }
});

test('real Git scope uses the complete immutable history and still rejects invalid revisions', t => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-history-statistics-'));
  t.after(() => fs.rmSync(repository, {recursive: true, force: true}));
  const git = args => execFileSync('git', ['-C', repository, ...args], {env: scanEnvironment, encoding: 'utf8'}).trim();
  git(['init', '-q']);
  fs.writeFileSync(path.join(repository, 'fixture.txt'), 'one\ntwo\n');
  git(['add', '.']);
  git(['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  const scope = resolveScope({repository, targetRef: 'HEAD', expectedCommit: commit});
  assert.equal(scope.scannableAddedLines, 2);
  assert.equal(historyAdditions(repository, scannerLogOptions({commits: [commit]}), scanEnvironment), 2);
  assert.throws(() => historyAdditions(repository, scannerLogOptions({commits: ['f'.repeat(40)]}), scanEnvironment),
    /scan_revision_count_invalid/);
});
