"""Execute only the operator-pinned public pure Node preparation closure.

Reads Git objects, never imports mutable worktree files. No provider or live
store operations. The operator must independently review/trust the commit.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from desktop_restore import MAX_BYTES, RecoveryError

SOURCE_DIRECTORY = 'packages/browsers/src/'
SOURCE_NAMES = ('desktop-lease-legacy.js', 'desktop-lease-canonical.js',
                'desktop-lease-structure.js', 'desktop-lease-lock.js')
ENVIRONMENT = {'PATH': os.defpath, 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1'}
RUNNER = r'''
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.argv[1], expected=process.argv[2];
const {prepareLegacyCohort,serializePreparedLegacy}=await import(pathToFileURL(root+'/desktop-lease-legacy.js'));
const {parseLegacyJson}=await import(pathToFileURL(root+'/desktop-lease-canonical.js'));
const raw=fs.readFileSync(0);
if(raw.length>8*1024*1024||createHash('sha256').update(raw).digest('hex')!==expected)throw Error('source_pin_mismatch');
const revokedAt=process.argv[3]||new Date().toISOString();
const {state,adoption}=prepareLegacyCohort(parseLegacyJson(raw),{sourceSha256:expected,revokedAt});
const output=serializePreparedLegacy(state);
const receipt=Buffer.from(JSON.stringify(adoption)+'\n','utf8');
if(output.length>8*1024*1024||receipt.length>1024*1024)throw Error('prepared_size_exceeded');
if(adoption.sourceSha256!==expected||adoption.preparedSha256!==createHash('sha256').update(output).digest('hex'))throw Error('prepared_pin_mismatch');
process.stdout.write(JSON.stringify({output:output.toString('base64'),receipt:receipt.toString('base64')}));
'''


class PinnedNodePreparer:
    def __init__(self, repository, commit):
        if not re.fullmatch('[0-9a-f]{40}', commit):
            raise RecoveryError('full reviewed validator commit required')
        repository = Path(repository).resolve(strict=True)
        self.sources = {}
        for name in SOURCE_NAMES:
            try:
                result = subprocess.run(['git', '--no-replace-objects', '-C', str(repository),
                                         'cat-file', 'blob', commit+':'+SOURCE_DIRECTORY+name],
                                        env=ENVIRONMENT, capture_output=True, timeout=10, check=True)
            except (OSError, subprocess.SubprocessError) as error:
                raise RecoveryError('pinned validator source unavailable') from error
            if not result.stdout or len(result.stdout) > 1024 * 1024:
                raise RecoveryError('bounded validator source required')
            self.sources[name] = result.stdout
        self.provenance = dict(format='desktop-legacy-node-preparer-v1', sourceCommit=commit,
                               files={SOURCE_DIRECTORY+name: hashlib.sha256(data).hexdigest()
                                      for name, data in self.sources.items()})

    def __call__(self, raw, digest, *, revoked_at=None):
        if len(raw) > MAX_BYTES or hashlib.sha256(raw).hexdigest() != digest:
            raise RecoveryError('bounded pinned source required')
        # The directory is our own private source export, not a product home.
        with tempfile.TemporaryDirectory(prefix='desktop-legacy-source-') as directory:
            root = Path(directory)
            (root/'package.json').write_text('{"type":"module"}\n')
            for name, data in self.sources.items():
                (root/name).write_bytes(data)
            try:
                result = subprocess.run(['node', '--input-type=module', '-e', RUNNER,
                                         str(root), digest, revoked_at or ''], input=raw,
                                        env=ENVIRONMENT, capture_output=True, timeout=15, check=True)
                value = json.loads(result.stdout)
                output = base64.b64decode(value['output'], validate=True)
                receipt = base64.b64decode(value['receipt'], validate=True)
            except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
                # Child diagnostics are intentionally not copied into operator
                # output: they must never leak original fields or payloads.
                raise RecoveryError('pinned Node legacy preparation refused') from error
        if len(output) > MAX_BYTES or len(receipt) > 1024 * 1024:
            raise RecoveryError('prepared evidence exceeds bound')
        return output, receipt
