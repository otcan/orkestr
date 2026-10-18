#!/usr/bin/env python3
"""Opt-in populated schema 14 -> explicit successor package probe; no builds or providers.

Retains the private pre-upgrade backup and complete stopped rollback home.
Never points the older server at the migrated working home. The only backward
open is an intentional refusal test on a separate disposable full-home copy.
"""
import argparse
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

from real_package import (Client, builder, invoke, launch, require, sha256,
                          smoke, stop_owned, verify_history)


def versions(home):
    db = home / 'data/core.sqlite3'
    with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as connection:
        require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'database integrity')
        return [r[0] for r in connection.execute('SELECT version FROM _sqlx_migrations WHERE success ORDER BY version')]


def exercise(args):
    successor = getattr(args, 'new_schema', 15)
    require(isinstance(successor,int) and 15 <= successor <= 9999, 'explicit supported successor schema required')
    old, new = Path(args.old_binary).resolve(), Path(args.new_binary).resolve()
    require(sha256(old) == args.old_sha256 and sha256(new) == args.new_sha256, 'pinned artifact mismatch')
    require(args.old_source != args.new_source and args.old_sha256 != args.new_sha256, 'distinct revisions required')
    parent = Path(args.parent)
    require(parent.is_absolute() and parent.is_dir(), 'existing private parent required')
    root = Path(tempfile.mkdtemp(prefix='v2-upgrade-', dir=parent))
    evidence = {'old_source': args.old_source, 'new_source': args.new_source,
                'old_binary_sha256': args.old_sha256, 'new_binary_sha256': args.new_sha256,
                'scope': f'same-owner populated package migration 14 to {successor}; rollback uses untouched pre-migration full-home copy',
                'old_schema':14, 'new_schema':successor,
                'checks': [], 'unexecuted': ['cross-version dormant import', 'owner rebinding', 'providers',
                                            'browser', 'production', 'power-loss recovery']}
    process = None
    try:
        old_package = builder.assemble(old, root/'old-package', '0.1.0-schema14-probe', args.old_source, Path(args.ui))
        new_package = builder.assemble(new, root/'new-package', f'0.1.0-schema{successor}-probe', args.new_source, Path(args.ui))
        old_entry, new_entry = old_package/'bin/orkestr-v2', new_package/'bin/orkestr-v2'
        home, rollback, refused = root/'working', root/'rollback', root/'refusal-copy'
        invoke(old_entry, 'install', home, '--package', old_package, '--port', args.port)
        client = Client(args.port)
        with (root/'private-probe.log').open('wb') as log:
            process = launch(old_entry, home, client, log)
            path, receipt, message = smoke(client, (home/'control/bootstrap.token').read_text())
            invoke(old_entry, 'stop', home); require(process.wait(timeout=10) == 0, 'old stop'); process = None
            require(versions(home) == list(range(1, 15)), 'old artifact must create exact schema14')
            invoke(old_entry, 'backup', home, '--output', root/'preserved-snapshot')
            backup_hash = sha256(root/'preserved-snapshot/core.sqlite3')
            # Complete stopped copy includes the original owner's bootstrap/config;
            # this is rollback of this instance, not a dormant import activation API.
            shutil.copytree(home, rollback)
            rollback_hash = sha256(rollback/'data/core.sqlite3')
            evidence['checks'].append('old executable created populated schema14; verified stopped backup and untouched rollback copy')
            invoke(new_entry, 'upgrade', home, '--package', new_package)
            process = launch(new_entry, home, client, log)
            verify_history(client, path, receipt, message)
            require(client.request('POST', path+'/messages', message) == (200, receipt), 'upgraded idempotency')
            invoke(new_entry, 'stop', home); require(process.wait(timeout=10) == 0, 'new stop'); process = None
            require(versions(home) == list(range(1, successor+1)), 'successor must migrate to declared exact schema')
            evidence['checks'].append(f'new executable migrated populated14 to{successor}; original session/history/idempotency retained')
            # Never downgrade the migrated working fixture. Only an isolated copy
            # is passed to the older executable to measure its refusal behavior.
            shutil.copytree(home, refused)
            invoke(old_entry, 'upgrade', refused, '--package', old_package)
            before = {p.name: sha256(p) for p in (refused/'data').iterdir() if p.is_file()}
            rejected_process = subprocess.Popen([str(old_entry), 'start', '--home', str(refused)],
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                rejected_process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                stop_owned(rejected_process)
                raise RuntimeError('old executable did not promptly refuse successor schema')
            require(rejected_process.returncode != 0, 'old executable unexpectedly accepted successor schema')
            after = {p.name: sha256(p) for p in (refused/'data').iterdir() if p.is_file()}
            require(before == after and versions(refused) == list(range(1, successor+1)), 'backward refusal changed database')
            evidence['backward_refusal'] = {'exit_code': rejected_process.returncode, 'database_inventory_unchanged': True}
            evidence['checks'].append(f'old executable refused disposable schema{successor} copy without database inventory mutation')
            require(sha256(rollback/'data/core.sqlite3') == rollback_hash, 'rollback copy was modified')
            process = launch(old_entry, rollback, client, log)
            verify_history(client, path, receipt, message)
            require(client.request('POST', path+'/messages', message) == (200, receipt), 'rollback idempotency')
            invoke(old_entry, 'stop', rollback); require(process.wait(timeout=10) == 0, 'rollback stop'); process = None
            require(versions(rollback) == list(range(1, 15)), 'rollback schema changed')
            require(sha256(root/'preserved-snapshot/core.sqlite3') == backup_hash, 'preserved backup changed')
            evidence['preserved_backup_sha256'] = backup_hash
            evidence['checks'].append('old executable recovered original owner/history on untouched schema14 rollback home; backup preserved')
        evidence['status'] = 'passed'
    finally:
        if process is not None:
            stop_owned(process)
        (root/'evidence.json').write_text(json.dumps(evidence, indent=2, sort_keys=True)+'\n')
        print('Private synthetic backup/rollback evidence retained at '+str(root))
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('old-binary', 'old-sha256', 'old-source', 'new-binary', 'new-sha256', 'new-source', 'ui', 'parent'):
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--new-schema', type=int, default=15)
    parser.add_argument('--port', required=True, type=int)
    print(json.dumps(exercise(parser.parse_args()), indent=2, sort_keys=True))
