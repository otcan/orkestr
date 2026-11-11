import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fakeDirectory} from '../../../../ci/local-files-fake-directory.mjs';
import {FolderError, LIMITS, hashFiles, listFolder, packageFiles, packageName, readFile, splitPath, writeFile} from './folder.mjs';

const tree = () => ({'b.txt': 'bravo', 'a.txt': 'alpha', 'empty.txt': '', docs: {'plan.md': '# Plan\n', deep: {'x.bin': new Uint8Array([0, 1, 2])}}});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function code(promise) {
  try { await promise; } catch (error) { return error instanceof FolderError ? error.code : `unexpected ${error.name}: ${error.message}`; }
  return 'resolved';
}
// Reads a ustar archive back and checks every header checksum.
function untar(bytes) {
  const files = [];
  for (let at = 0; at + 512 <= bytes.length;) {
    const header = bytes.subarray(at, at + 512);
    if (header.every(b => b === 0)) break;
    const field = (offset, length) => new TextDecoder().decode(header.subarray(offset, offset + length)).replace(/\0[\s\S]*$/, '');
    const copy = Uint8Array.from(header); copy.fill(0x20, 148, 156);
    assert.equal(copy.reduce((n, b) => n + b, 0), parseInt(field(148, 8), 8), 'header checksum');
    assert.equal(field(257, 6), 'ustar');
    const size = parseInt(field(124, 12), 8), prefix = field(345, 155), name = field(0, 100);
    files.push({path: prefix ? `${prefix}/${name}` : name, text: new TextDecoder().decode(bytes.subarray(at + 512, at + 512 + size))});
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('paths are refused before the browser is asked for anything outside the folder', async () => {
  for (const ok of ['a.txt', 'docs/plan.md', '.hidden', 'with space/ü.txt']) assert.ok(splitPath(ok).length >= 1, ok);
  assert.deepEqual(splitPath('', {root: true}), []);
  const root = fakeDirectory(tree());
  for (const bad of ['', '..', '../secret', 'docs/../../secret', '/etc/passwd', 'docs/', 'a//b', './a.txt', 'docs/.', 'a\\b', 'a\u0000b', 'x/'.repeat(40) + 'y', 'n'.repeat(256)]) {
    assert.equal(await code(readFile(root, bad)), 'invalid_path', JSON.stringify(bad));
    assert.equal(await code(writeFile(root, bad, new Uint8Array(1))), 'invalid_path', JSON.stringify(bad));
  }
  assert.equal(await code(listFolder(root, '../')), 'invalid_path');
  assert.deepEqual(root.fake.calls, [], 'no handle was touched for a refused path');
});

test('a listing is one directory, sorted, with sizes; browser errors map to stable codes', async () => {
  const root = fakeDirectory(tree());
  const top = await listFolder(root, '');
  assert.deepEqual(top.entries.map(e => [e.name, e.kind, e.size ?? null]), [['a.txt', 'file', 5], ['b.txt', 'file', 5], ['docs', 'directory', null], ['empty.txt', 'file', 0]]);
  assert.equal(top.truncated, false);
  assert.deepEqual((await listFolder(root, 'docs')).entries.map(e => e.name), ['deep', 'plan.md']);
  assert.equal(await code(listFolder(root, 'missing')), 'not_found');
  assert.equal(await code(listFolder(root, 'a.txt')), 'not_a_directory');
  assert.equal(await code(readFile(root, 'docs')), 'not_a_file');
  const many = Object.fromEntries(Array.from({length: LIMITS.listMax + 5}, (_, i) => [`f${String(i).padStart(4, '0')}`, '']));
  const big = await listFolder(fakeDirectory(many), '');
  assert.equal(big.entries.length, LIMITS.listMax);
  assert.equal(big.truncated, true);
  const denied = fakeDirectory(tree(), {read: 'prompt'});
  assert.equal(await code(listFolder(denied, '')), 'permission_denied');
});

test('reads return the file itself and hashes are SHA-256 of the exact bytes', async () => {
  const root = fakeDirectory(tree());
  const file = await readFile(root, 'docs/plan.md');
  assert.equal(await file.text(), '# Plan\n');
  assert.equal(await code(readFile(root, 'docs/plan.md', 3)), 'too_large');
  const hashes = await hashFiles(root, ['a.txt', 'docs/deep/x.bin', 'empty.txt']);
  assert.deepEqual(hashes.files, [
    {path: 'a.txt', size: 5, sha256: sha('alpha')},
    {path: 'docs/deep/x.bin', size: 3, sha256: sha(Buffer.from([0, 1, 2]))},
    {path: 'empty.txt', size: 0, sha256: sha('')},
  ]);
  assert.equal(await code(hashFiles(root, ['a.txt', 'nope.txt'])), 'not_found');
});

test('writes create or replace one file inside an existing folder of the grant', async () => {
  const root = fakeDirectory(tree());
  assert.equal(await code(writeFile(root, 'a.txt', new TextEncoder().encode('x'))), 'permission_denied', 'read-only until the owner allows a write');
  assert.equal(root.fake.text('a.txt'), 'alpha');
  assert.equal(await root.requestPermission({mode: 'readwrite'}), 'granted');
  const replaced = await writeFile(root, 'a.txt', new TextEncoder().encode('changed'));
  assert.deepEqual(replaced, {bytes_written: 7, sha256: sha('changed'), created: false});
  assert.equal(root.fake.text('a.txt'), 'changed');
  const created = await writeFile(root, 'docs/new.md', new TextEncoder().encode('new'));
  assert.equal(created.created, true);
  assert.equal(root.fake.text('docs/new.md'), 'new');
  assert.equal(await code(writeFile(root, 'missing/dir/file.txt', new Uint8Array(1))), 'not_found', 'no folders are created');
  assert.equal(await code(writeFile(root, 'docs', new Uint8Array(1))), 'not_a_file');
  assert.equal(await code(writeFile(root, 'big.bin', new Uint8Array(LIMITS.writeMax + 1))), 'too_large');
});

test('a package is a ustar archive of exactly the selection, with the server archive name', async () => {
  const root = fakeDirectory({...tree(), [`${'d'.repeat(120)}`]: {'long-name.txt': 'long path'}});
  const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  assert.equal(packageName(id), 'selection-0f1e2d3c4b5a.tar');
  const {file, files} = await packageFiles(root, ['a.txt', 'docs/plan.md', 'empty.txt', `${'d'.repeat(120)}/long-name.txt`], packageName(id));
  assert.equal(file.name, 'selection-0f1e2d3c4b5a.tar');
  assert.equal(file.type, 'application/x-tar');
  assert.equal(file.size % 512, 0);
  assert.deepEqual(files.map(f => [f.path, f.size]), [['a.txt', 5], ['docs/plan.md', 7], ['empty.txt', 0], [`${'d'.repeat(120)}/long-name.txt`, 9]]);
  assert.deepEqual(untar(new Uint8Array(await file.arrayBuffer())), [
    {path: 'a.txt', text: 'alpha'}, {path: 'docs/plan.md', text: '# Plan\n'}, {path: 'empty.txt', text: ''},
    {path: `${'d'.repeat(120)}/long-name.txt`, text: 'long path'},
  ]);
  assert.equal(await code(packageFiles(root, ['a.txt', '../x'], 'x.tar')), 'invalid_path');
  assert.equal(await code(packageFiles(root, [], 'x.tar')), 'invalid_path');
  const unsplittable = fakeDirectory({['n'.repeat(200)]: 'x'});
  assert.equal(await code(packageFiles(unsplittable, ['n'.repeat(200)], 'x.tar')), 'invalid_path');
});
