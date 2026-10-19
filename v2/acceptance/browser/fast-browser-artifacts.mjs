// Bind every imported synthetic fixture/broker module to the selected Git commit.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digest } from './support.mjs';
const exec = promisify(execFile);
const modules = ['owned_execution_http.py', 'owned_native_probe.py', 'owned_execution_group.py',
  'owned_fast_case.py', 'owned_fast_peer.py', 'owned_execution_peer.py'].map(name => `v2/tests/${name}`);
const broker = ['server.py', 'configuration.py', 'protocol.py', 'transport.py', 'codex_bootstrap.py',
  'reaping.py', 'codex-package.json'].map(name => `v2/provider-broker/${name}`);

export async function fixtureSource(artifact) {
  const fixture = artifact.fixture;
  assert(fixture && path.isAbsolute(fixture.path) && path.isAbsolute(fixture.repository), 'fixture_source_required');
  assert.equal(fixture.source_sha, artifact.server.source_sha, 'fixture_server_source_mismatch');
  assert.equal(artifact.ui.source_sha, artifact.server.source_sha, 'matching_ui_server_pair_required');
  const hashes = {};
  const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'advice.graftFileDeprecated', GIT_CONFIG_VALUE_0: 'false' };
  for (const name of [...modules, ...broker]) {
    const file = path.join(fixture.path, name);
    const stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'regular_fixture_source_required');
    const actual = await fs.readFile(file);
    assert(actual.length <= 1024 * 1024, 'fixture_source_bound');
    const tracked = await exec('/usr/bin/git', ['-C', fixture.repository, 'cat-file', 'blob',
      `${fixture.source_sha}:${name}`], { env: environment, encoding: 'buffer', maxBuffer: 1024 * 1024 });
    assert.equal(digest(actual), digest(tracked.stdout), 'fixture_tracked_source_mismatch');
    hashes[name] = digest(actual);
  }
  const inventory = JSON.parse(await fs.readFile(path.join(fixture.path, 'v2/provider-broker/codex-package.json')));
  for (const [name, sha] of Object.entries(inventory.files)) {
    assert.equal(hashes[`v2/provider-broker/${name}`], sha, 'broker_inventory_mismatch');
  }
  return { path: fixture.path, source_sha: fixture.source_sha, hashes };
}
