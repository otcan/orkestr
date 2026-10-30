#!/usr/bin/env python3
"""Seal paired, already-built artifacts; never build, download or load credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

FORMAT = 'orkestr-v2-paired-artifacts-v1'
BETA_VERSIONS = ('2.0.0-beta.1', '2.0.0-beta.2', '2.0.0-beta.3', '2.0.0-beta.4', '2.0.0-beta.5')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def validate_version(version):
    require(isinstance(version, str) and
            (version in BETA_VERSIONS or re.fullmatch(r'2\.0\.0-rc\.[1-9][0-9]*', version)),
            'explicit 2.0.0-rc.N or explicit 2.0.0-beta.1/beta.2/beta.3/beta.4/beta.5 version required')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root):
    require(root.is_dir() and not root.is_symlink(), 'regular web root required')
    result = {}
    for path in sorted(root.rglob('*')):
        require(not path.is_symlink(), 'artifact symlinks refused')
        if path.is_dir():
            continue
        require(path.is_file(), 'regular artifact files required')
        result[path.relative_to(root).as_posix()] = {'bytes': path.stat().st_size, 'sha256': sha(path)}
    require('index.html' in result and any(p.endswith('.wasm') for p in result), 'genuine web index/WASM required')
    return result


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], check=True, text=True,
                          capture_output=True).stdout.strip()


def schema(root, source):
    prefix = 'v2/crates/store-sqlite/migrations/'
    names = git(root, 'ls-tree', '-r', '--name-only', source, prefix).splitlines()
    require(names, 'source migration inventory required')
    result = {}
    for name in names:
        require(re.fullmatch(prefix + r'[0-9]{4}_[a-z0-9_]+\.sql', name), 'unexpected migration path')
        content = subprocess.run(['git', '-C', str(root), 'show', source+':'+name],
                                 check=True, capture_output=True).stdout
        result[Path(name).name] = hashlib.sha256(content).hexdigest()
    return result


def seal(checkout, binary, ui, source, version, profile, features, required_glibc, execution_controls=False):
    require(re.fullmatch(r'[0-9a-f]{40}', source), 'exact full source required')
    validate_version(version)
    require(profile in ('debug', 'release'), 'supported profile required')
    require(re.fullmatch(r'2\.[0-9]+', required_glibc), 'explicit glibc requirement required')
    require(git(checkout, 'rev-parse', 'HEAD') == source, 'producer checkout must match exact source')
    require(not git(checkout, 'status', '--porcelain', '--untracked-files=normal'), 'clean tracked producer checkout required')
    require(binary.is_file() and not binary.is_symlink(), 'regular built server required')
    header = binary.read_bytes()[:20]
    require(header[:6] == b'\x7fELF\x02\x01' and header[18:20] == b'\x3e\x00', 'Linux x86_64 ELF required')
    web = inventory(ui)
    require(all(re.fullmatch(r'[a-zA-Z0-9_-]+', f) for f in features), 'explicit feature names required')
    value = {'format': FORMAT, 'version': version, 'source_commit': source, 'target': 'linux-x86_64',
            'server': {'sha256': sha(binary), 'bytes': binary.stat().st_size, 'profile': profile,
                       'features': sorted(set(features)), 'default_features': True},
            'web': {'files': web, 'inventory_sha256': digest(web), 'profile': 'release',
                    'target': 'wasm32-unknown-unknown', 'features': ['web'], 'default_features': False},
            'schema': {'migrations': schema(checkout, source), 'automatic_start_migrations': True},
            'build_contract': {'wrapper': 'V2_CARGO', 'server_flags': ['--offline', '--locked'],
                               'web_command': 'v2/apps/ui/scripts/bundle.sh', 'wasm_bindgen': '0.2.129',
                               'rust_toolchain_sha256': hashlib.sha256(subprocess.run(
                                   ['git','-C',str(checkout),'show',source+':v2/rust-toolchain.toml'],
                                   check=True,capture_output=True).stdout).hexdigest(),
                               'required_glibc': required_glibc},
            'provenance': 'producer declares both artifacts built from this clean revision; hashes are integrity, not signed build attestation'}

    if execution_controls:
        value['web']['features'] = ['web','execution-controls']
        value['web']['server_candidate'] = source
    return value


def verify(receipt, binary, ui):
    require(receipt['format'] == FORMAT and receipt['target'] == 'linux-x86_64', 'supported paired receipt required')
    validate_version(receipt.get('version'))
    require(re.fullmatch(r'[0-9a-f]{40}', receipt['source_commit']), 'full paired source required')
    require(not binary.is_symlink() and sha(binary) == receipt['server']['sha256'] and
            binary.stat().st_size == receipt['server']['bytes'], 'server identity mismatch')
    actual = inventory(ui)
    require(actual == receipt['web']['files'] and digest(actual) == receipt['web']['inventory_sha256'], 'web identity mismatch')
    controls = 'execution-controls' in receipt['web'].get('features', [])
    binding = receipt['web'].get('server_candidate')
    require((controls and receipt['web']['features'] == ['web','execution-controls'] and binding == receipt['source_commit']) or
            (not controls and binding is None), 'web execution controls candidate binding mismatch')
    require(receipt['schema']['migrations'], 'schema metadata required')
    return receipt


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('checkout','binary','ui','source','version','profile','required-glibc','output'):
        p.add_argument('--'+name, required=True)
    p.add_argument('--feature', action='append', default=[])
    p.add_argument('--execution-controls', action='store_true', help='Declare controls UI bound to this exact source')
    a = p.parse_args()
    value = seal(Path(a.checkout), Path(a.binary), Path(a.ui), a.source, a.version, a.profile, a.feature, a.required_glibc, a.execution_controls)
    with open(a.output, 'x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True); stream.write('\n')
