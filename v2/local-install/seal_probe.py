#!/usr/bin/env python3
"""Prepare an immutable Git-byte helper export and argv record; never execute a probe.

This is a pre-execution source inventory, not proof of which modules a later
process imports. The operator must retain execution logs alongside this plan.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOTS = ('v2/local-install/', 'v2/packaging/')


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True,
                          capture_output=True).stdout


def seal(repo, output, entry, arguments):
    repo, output = Path(repo).resolve(), Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise RuntimeError('fresh output required')
    source = git(repo, 'rev-parse', 'HEAD').decode().strip()
    names = git(repo, 'ls-tree', '-r', '--name-only', source, '--', *ROOTS).decode().splitlines()
    if entry not in names or not entry.endswith('.py'):
        raise RuntimeError('committed owned Python entry required')
    blobs = {}
    for name in names:
        data = git(repo, 'show', source + ':' + name)
        live = repo / name
        if live.is_symlink() or not live.is_file() or live.read_bytes() != data:
            raise RuntimeError('helper checkout differs from committed source: ' + name)
        blobs[name] = data
    # No output exists until all source validation has completed.
    output.mkdir(mode=0o700)
    inventory = {}
    for name, data in blobs.items():
        target = output / 'closure' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o400)
        inventory[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    command = [sys.executable, '-B', str(output / 'closure' / entry), *arguments]
    value = {'format': 'orkestr-install-probe-plan-v1', 'source_commit': source,
             'status': 'prepared_unexecuted', 'argv': command,
             'python': {'executable': sys.executable, 'version': sys.version},
             'environment_contract': 'operator must separately retain exact allowlisted execution environment; no credentials',
             'inventory': inventory,
             'limits': ['Git-byte export, not dynamic import attestation',
                        'artifacts/config/fixture pins must be recorded by the probe before execution',
                        'no historical attestation or execution qualification']}
    path = output / 'plan.json'
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    path.chmod(0o400)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--entry', required=True)
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    arguments = args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments
    print(seal(args.repo, args.output, args.entry, arguments))


if __name__ == '__main__':
    main()
