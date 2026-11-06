import assert from 'node:assert/strict';
import test from 'node:test';
import {preflightScopedGroupConfigs} from '../scripts/scoped-group-preflight.mjs';

const groups = [{chatId: '120000000001@g.us', threadId: 'thread-a'}, {chatId: '120000000002@g.us', threadId: 'thread-b'}];
const base = {ownChatId: '15550000001@c.us', activatedAt: '2026-01-01T00:00:00Z', groups,
  routeControl: {routeId: 'route-1', dbPath: '/nonexistent/route.sqlite', threadIds: ['thread-a', 'thread-b']}};
const files = {
  '/cfg/multi.json': JSON.stringify({...base, timerNotifications: {enabled: true, allGroups: true, proofDbPath: '/nonexistent/p.sqlite', since: '2026-01-01T00:00:00Z'}}),
  '/cfg/legacy-timer.json': JSON.stringify({...base, timerNotifications: {enabled: true, threadId: 'thread-a', proofDbPath: '/nonexistent/p.sqlite', since: '2026-01-01T00:00:00Z'}}),
  '/cfg/bad-fence.json': JSON.stringify({...base, routeControl: {...base.routeControl, threadId: 'thread-a'}}),
  '/cfg/garbage.json': '{"secret-ish": 4915550000000',
};
const readFile = file => { if (!(file in files)) throw new Error('ENOENT'); return files[file]; };

test('preflight accepts live-shaped multi-thread configs without opening any database', () => {
  const result = preflightScopedGroupConfigs(['/cfg/multi.json', '/cfg/legacy-timer.json', '/cfg/multi.json'], {readFile});
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
});

test('preflight blocks activation on a rejected contract and never echoes file content', () => {
  const result = preflightScopedGroupConfigs(['/cfg/multi.json', '/cfg/bad-fence.json', '/cfg/garbage.json'], {readFile});
  assert.equal(result.ok, false);
  assert.equal(result.results.find(r => r.file === '/cfg/bad-fence.json').code, 'scoped_worker_configuration_invalid');
  assert.equal(result.results.find(r => r.file === '/cfg/garbage.json').code, 'configuration_unreadable');
  assert.doesNotMatch(JSON.stringify(result), /4915550000000|secret-ish/);
});

test('preflight validates owner-approved direct chats like the worker does at startup', () => {
  const direct = {journalPath: '/nonexistent/direct.sqlite', routes: [{threadId: 'thread-a', chatIds: ['15550000002@c.us']}]};
  const extra = {
    '/cfg/direct-ok.json': JSON.stringify({...base, directChats: direct}),
    '/cfg/direct-bad-thread.json': JSON.stringify({...base, directChats: {...direct, routes: [{threadId: 'not-scoped', chatIds: ['15550000002@c.us']}]}}),
    '/cfg/direct-no-journal.json': JSON.stringify({...base, directChats: {routes: direct.routes}}),
  };
  const read = file => extra[file] ?? readFile(file);
  assert.equal(preflightScopedGroupConfigs(['/cfg/direct-ok.json'], {readFile: read}).ok, true);
  for (const file of ['/cfg/direct-bad-thread.json', '/cfg/direct-no-journal.json']) {
    const result = preflightScopedGroupConfigs([file], {readFile: read});
    assert.equal(result.ok, false, file);
    assert.equal(result.results[0].code, 'scoped_worker_direct_configuration_invalid');
    assert.doesNotMatch(JSON.stringify(result), /15550000002/);
  }
});

test('existing static journal contract catches nested JSON key ordering before activation, without writes', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {DatabaseSync} = await import('node:sqlite');
  const crypto = await import('node:crypto');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-preflight-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journalPath=path.join(dir,'input.sqlite'), config={...base,journalPath,groups:[{chatId:groups[0].chatId,threadId:'thread-a',name:'Example'}],routeControl:undefined};
  const db=new DatabaseSync(journalPath);
  db.exec('CREATE TABLE group_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const contract=crypto.createHash('sha256').update(JSON.stringify([config.ownChatId,config.activatedAt,config.groups])).digest('hex');
  db.prepare('INSERT INTO group_meta VALUES(?,?)').run('contract',contract);db.close();
  const before=fs.readFileSync(journalPath);
  const reordered={...config,groups:[{chatId:groups[0].chatId,name:'Example',threadId:'thread-a'}]};
  assert.deepEqual(config.groups,reordered.groups,'values match but the persisted contract preserves key order');
  const check=c=>preflightScopedGroupConfigs(['/cfg/live.json'],{readFile:()=>JSON.stringify(c)});
  assert.equal(check(config).ok,true);
  assert.equal(check(reordered).results[0].code,'group_transport_configuration_changed');
  assert.deepEqual(fs.readFileSync(journalPath),before);
});

test('absent and initial empty journals remain untouched; unreadable existing journals refuse', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-initial-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journalPath=path.join(dir,'input.sqlite'),config={...base,journalPath};
  const check=()=>preflightScopedGroupConfigs(['/cfg/live.json'],{readFile:()=>JSON.stringify(config)});
  assert.equal(check().ok,true);assert.equal(fs.existsSync(journalPath),false);
  fs.writeFileSync(journalPath,'');assert.equal(check().ok,true);assert.equal(fs.statSync(journalPath).size,0);
  fs.writeFileSync(journalPath,'not SQLite');
  assert.equal(check().results[0].code,'group_transport_journal_unreadable');
});
