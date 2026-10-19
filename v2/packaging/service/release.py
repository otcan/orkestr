"""Outer persistent-service release; leaves the closed inner inventory unchanged."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil

from closure import pin, require, trusted
from prepare import inventory


def wrapper(root, interpreter, manifest_sha):
    require(re.fullmatch('[0-9a-f]{64}', manifest_sha), 'inner manifest digest required')
    require(root.is_absolute() and root.resolve() == root, 'canonical release root required')
    command = [str(interpreter), '-I', '-S', '-B',
               str(root/'package/codex_service/entry.py'), 'manager', manifest_sha]
    return ('#!/bin/sh\nset -eu\n[ "$#" -eq 0 ] || exit 2\n'
            'unset ENV BASH_ENV CDPATH\nexec ' + shlex.join(command) + '\n').encode()


def prepare_release(package, manifest_sha, output):
    """Seal an already-prepared selected package, never activate or validate peers.

    Root operator must independently approve the inner manager source successor,
    private configuration and this outer receipt before publishing a current link.
    """
    require(output.is_absolute() and output.resolve() == output, 'canonical release root required')
    require(not output.exists() and not output.is_symlink(), 'fresh outer release required')
    require(package.is_absolute() and package.resolve() == package and package.is_dir(), 'canonical package required')
    require(not output.is_relative_to(package) and not package.is_relative_to(output), 'release/package overlap')
    require(re.fullmatch('[0-9a-f]{64}', manifest_sha), 'inner manifest digest required')
    before = inventory(package)
    require(pin(package/'manifest.json')['sha256'] == manifest_sha, 'inner manifest mismatch')
    value = json.loads((package/'manifest.json').read_bytes())
    require(value['format'] == 'orkestr-v2-codex-service-package-v1' and
            re.fullmatch('[0-9a-f]{40}', value['source_commit']), 'selected service package required')
    require('codex_service/entry.py' in before, 'no-site entry required')
    # Fixed trusted host interpreters, not caller-selected executables.
    interpreter = Path('/usr/bin/python3').resolve(strict=True)
    shell = Path('/bin/sh').resolve(strict=True)
    trusted(interpreter);trusted(shell)
    output.mkdir(mode=0o700)
    try:
        shutil.copytree(package, output/'package')
        require(inventory(package) == before and inventory(output/'package') == before,
                'inner package changed during copy')
        entry = output/'start-service'
        entry.write_bytes(wrapper(output, interpreter, manifest_sha));entry.chmod(0o550)
        receipt = {'format':'orkestr-v2-persistent-release-v1', 'source_commit':value['source_commit'],
                   'inner_manifest_sha256':manifest_sha, 'files':inventory(output),
                   'startup_dependencies':[pin(interpreter),pin(shell)],
                   'limits':['inner Package/peer/config acceptance remains separate',
                             'requires reviewed manager stopped-child race successor',
                             'no service installation or activation']}
        path = output/'release.json'
        path.write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n');path.chmod(0o440)
        return path
    except BaseException:
        shutil.rmtree(output)
        raise
