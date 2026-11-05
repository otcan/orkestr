import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
const exec=promisify(execFile);

test('SQLite archive stage: concurrent WAL, restored values, bounds and interruption', async()=>{
  const {stdout}=await exec('python3',['-B','test/fixtures/sqlite-backup-check.py'],{timeout:30000});
  assert.match(stdout,/all snapshot checks passed/);
});

test('SQLite restore/rebackup lifecycle, literal anchored paths and resolver padding', async()=>{
  const {stdout}=await exec('python3',['-B','test/fixtures/sqlite-backup-lifecycle-check.py'],{timeout:30000});
  assert.match(stdout,/all lifecycle checks passed/);
});

test('WAL copy pins one snapshot without blocking commits and releases it on interruption', async()=>{
  const {stdout}=await exec('python3',['-I','-S','-B','test/fixtures/sqlite-backup-wal-check.py'],{timeout:30000,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.match(stdout,/WAL snapshot stays consistent while writes commit/);
});
