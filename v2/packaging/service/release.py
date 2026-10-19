"""Outer persistent-service release; leaves the closed inner inventory unchanged."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat

from closure import pin, require, trusted
from prepare import inventory
from beta_config import validate as validate_beta_config


def wrapper(root, interpreter, manifest_sha):
    require(re.fullmatch('[0-9a-f]{64}', manifest_sha), 'inner manifest digest required')
    require(root.is_absolute() and root.resolve() == root, 'canonical release root required')
    command = [str(interpreter), '-I', '-S', '-B',
               str(root/'package/codex_service/entry.py'), 'manager', manifest_sha]
    return ('#!/bin/sh\nset -eu\n[ "$#" -eq 0 ] || exit 2\n'
            'unset ENV BASH_ENV CDPATH\nexec ' + shlex.join(command) + '\n').encode()



def final_bindings(package, destination, service_gid):
    """Reject a staged inner package still bound to its staging paths."""
    beta = validate_beta_config((package/'beta.json').read_bytes())
    profile = json.loads((package/'profile.json').read_bytes())
    runtime = json.loads((package/'service.json').read_bytes())
    require(type(service_gid) is int and 0 < service_gid < 2**31 and
            type(runtime.get('gid')) is int and runtime['gid'] == service_gid,
            'explicit configured service GID required')
    require(beta['launcher'] == str(destination/'launcher.py') and
            beta['launcher_sha256'] == pin(package/'launcher.py')['sha256'],
            'final launcher binding required')
    require(profile['native'] == str(destination/'native') and
            profile['supervisor'] == str(destination/'isolation/supervisor.py'),
            'final provider binding required')
    require(runtime['owner_id'] == beta['owner_id'] and
            runtime['conversation_id'] == beta['conversation_id'] and
            profile['workspace'] == beta['workspace'], 'inner scope binding required')


def prepare_release(package, manifest_sha, output, *, service_gid):
    """Seal an already-prepared selected package, never activate or validate peers.

    Root operator must independently approve the inner manager source successor,
    private configuration and this outer receipt before publishing a current link.
    """
    require(os.geteuid() == 0, 'root release preparation required')
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
    final_bindings(package, output/'package', service_gid)
    # Fixed trusted host interpreters, not caller-selected executables.
    interpreter = Path('/usr/bin/python3').resolve(strict=True)
    shell = Path('/bin/sh').resolve(strict=True)
    trusted(interpreter);trusted(shell)
    output.mkdir(mode=0o700)
    try:
        shutil.copytree(package, output/'package')
        require(inventory(package) == before and inventory(output/'package') == before,
                'inner package changed during copy')
        # copytree does not preserve source group ownership. Keep bytes/modes,
        # explicitly assign the configured group to the copied protected tree.
        for item in (output/'package', *(output/'package').rglob('*')):
            require(not item.stat().st_mode & 0o022, 'protected inner modes required')
            os.chown(item, 0, service_gid)
        os.chown(output, 0, service_gid);output.chmod(0o750)
        entry = output/'start-service'
        entry.write_bytes(wrapper(output, interpreter, manifest_sha));entry.chmod(0o550)
        os.chown(entry, 0, service_gid)
        receipt = {'format':'orkestr-v2-persistent-release-v1', 'source_commit':value['source_commit'],
                   'inner_manifest_sha256':manifest_sha, 'files':inventory(output),
                   'receipt_custody':{'uid':0,'gid':service_gid,'mode':0o440},
                   'startup_dependencies':[pin(interpreter),pin(shell)],
                   'custody':{str(p.relative_to(output)):{'uid':p.stat().st_uid,
                       'gid':p.stat().st_gid,'mode':stat.S_IMODE(p.stat().st_mode)}
                       for p in [output,*output.rglob('*')]},
                   'limits':['inner Package/peer/config acceptance remains separate',
                             'manager source and complete Package validation independently required',
                             'no service installation or activation']}
        path = output/'release.json'
        path.write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n');path.chmod(0o440);os.chown(path,0,service_gid)
        return path
    except BaseException:
        shutil.rmtree(output)
        raise
