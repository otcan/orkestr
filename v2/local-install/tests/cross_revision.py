#!/usr/bin/env python3
"""Opt-in populated supported older schema -> explicit successor package probe; no builds or providers.

Retains the private pre-upgrade backup and complete stopped rollback home.
Never points the older server at the migrated working home. The only backward
open is an intentional refusal test on a separate disposable full-home copy.
"""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile

import dormant_checkpoint
from stopped_copy import copy_home
from install_state import files

from real_package import (Client, builder, invoke, launch, require, sha256,
                          smoke, stop_owned, verify_history)


def versions(home):
    db = home / 'data/core.sqlite3'
    with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as connection:
        require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'database integrity')
        require(not connection.execute('PRAGMA foreign_key_check').fetchall(), 'database foreign keys')
        return [r[0] for r in connection.execute('SELECT version FROM _sqlx_migrations WHERE success ORDER BY version')]


def verify_schema(home, count, checksums=None):
    require(versions(home)==list(range(1,count+1)),'executable schema differs from declared migration inventory')
    if checksums is not None:
        require(all(str(version) in checksums for version in range(1,count+1)), 'missing exact source SQLx checksum')
        with closing(sqlite3.connect((home/'data/core.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:
            actual={str(version):bytes(checksum).hex() for version,checksum in
                    db.execute('SELECT version,checksum FROM _sqlx_migrations WHERE success')}
        require(actual=={str(version):checksums[str(version)] for version in range(1,count+1)},
                'actual SQLx migration checksum differs from exact Core source')
    return list(range(1,count+1))


def migration_edge(old, new):
    require(type(old) is int and type(new) is int and (old,new) in {(14,15),(14,17),(14,20),(17,20),(14,24),(17,24),(14,28),(17,28)},
            "unsupported migration edge; admitted edges: 14->15/17/20/24/28 and 17->20/24/28")
    return old,new


def selected_package(args, side, binary, output, schema):
    existing=getattr(args,side+'_package',None)
    source=getattr(args,side+'_source')
    if existing is None:
        return builder.assemble(binary,output,f'0.1.0-schema{schema}-probe',source,Path(args.ui))
    root,manifest=builder.package(Path(existing))
    require(manifest['source_commit']==source and sha256(root/'server/orkestr-v2-server')==sha256(binary),
            'selected package source/binary mismatch')
    return root


def exercise(args):
    successor = getattr(args, 'new_schema', 15)
    predecessor, successor = migration_edge(getattr(args, 'old_schema', 14), successor)
    require(successor!=28 or bool(getattr(args,'sqlx_checksums',None)), 'schema28 requires exact Core SQLx checksums; use candidate accept_upgrade with migrations-dir')
    old, new = Path(args.old_binary).resolve(), Path(args.new_binary).resolve()
    require(sha256(old) == args.old_sha256 and sha256(new) == args.new_sha256, 'pinned artifact mismatch')
    require(args.old_source != args.new_source and args.old_sha256 != args.new_sha256, 'distinct revisions required')
    parent = Path(args.parent)
    require(parent.is_absolute() and parent.is_dir(), 'existing private parent required')
    root = Path(tempfile.mkdtemp(prefix='v2-upgrade-', dir=parent))
    evidence = {'old_source': args.old_source, 'new_source': args.new_source,
                'old_binary_sha256': args.old_sha256, 'new_binary_sha256': args.new_sha256,
                'scope': f'same-owner populated package migration {predecessor} to {successor}; rollback uses untouched pre-migration full-home copy',
                'old_schema':predecessor, 'new_schema':successor,
                'exact_source_sqlx_checksums_checked':getattr(args,'sqlx_checksums',None) is not None,
                'checks': [], 'unexecuted': ['cross-version dormant import', 'owner rebinding', 'providers',
                                            'browser', 'production', 'power-loss recovery']}
    process = None
    try:
        old_package = selected_package(args, 'old', old, root/'old-package', predecessor)
        new_package = selected_package(args, 'new', new, root/'new-package', successor)
        old_entry, new_entry = old_package/'bin/orkestr-v2', new_package/'bin/orkestr-v2'
        evidence['packages']={side:{'manifest_sha256':sha256(root/'manifest.json'),
            **{key:builder.package(root)[1][key] for key in ('version','source_commit','target')}}
            for side,root in (('old',old_package),('new',new_package))}
        home, rollback, refused = root/'working', root/'rollback', root/'refusal-copy'
        invoke(old_entry, 'install', home, '--package', old_package, '--port', args.port)
        client = Client(args.port)
        with (root/'private-probe.log').open('wb') as log:
            process = launch(old_entry, home, client, log)
            path, receipt, message = smoke(client, (home/'control/bootstrap.token').read_text())
            invoke(old_entry, 'stop', home); require(process.wait(timeout=10) == 0, 'old stop'); process = None
            verify_schema(home,predecessor,getattr(args,'sqlx_checksums',None))
            invoke(old_entry, 'backup', home, '--output', root/'preserved-snapshot')
            backup_hash = sha256(root/'preserved-snapshot/core.sqlite3')
            backup_manifest_hash=sha256(root/'preserved-snapshot/manifest.json')
            # Complete stopped copy includes the original owner's bootstrap/config;
            # this is rollback of this instance, not a dormant import activation API.
            copy_home(home, rollback)
            rollback_inventory=files(rollback/'data')
            evidence['predecessor_rollback_database_inventory']=rollback_inventory
            evidence['checks'].append(f'old executable created populated schema{predecessor}; verified stopped backup and untouched rollback copy')
            preflight=root/'preflight-copy'
            copy_home(home,preflight)
            source_before=files(home/'data')
            invoke(new_entry,'upgrade',preflight,'--package',new_package)
            process=launch(new_entry,preflight,client,log)
            verify_history(client,path,receipt,message)
            invoke(new_entry,'stop',preflight);require(process.wait(timeout=10)==0,'preflight copy stop');process=None
            verify_schema(preflight,successor,getattr(args,'sqlx_checksums',None))
            require(files(home/'data')==source_before,'copy-upgrade preflight changed original database/WAL/SHM')
            evidence['copy_upgrade_preflight']={'schema_versions':list(range(1,successor+1)),
                'original_database_inventory_unchanged':True,'foreign_keys_checked':True}
            evidence['checks'].append('successor copy-upgrade/FK/history preflight passed before writable original migration')
            invoke(new_entry, 'upgrade', home, '--package', new_package)
            process = launch(new_entry, home, client, log)
            verify_history(client, path, receipt, message)
            require(client.request('POST', path+'/messages', message) == (200, receipt), 'upgraded idempotency')
            invoke(new_entry, 'stop', home); require(process.wait(timeout=10) == 0, 'new stop'); process = None
            verify_schema(home,successor,getattr(args,'sqlx_checksums',None))
            evidence['checks'].append(f'new executable migrated populated{predecessor} to{successor}; original session/history/idempotency retained')
            process = launch(new_entry, home, client, log)
            verify_history(client, path, receipt, message)
            require(client.request('POST', path+'/messages', message) == (200, receipt), 'successor reopen idempotency')
            invoke(new_entry, 'stop', home); require(process.wait(timeout=10) == 0, 'successor reopen stop'); process = None
            verify_schema(home,successor,getattr(args,'sqlx_checksums',None))
            evidence['checks'].append('successor reopened migrated home with original history/idempotency and unchanged schema')
            evidence['successor_dormant_restore']=dormant_checkpoint.exercise(
                new_entry,new_package,home,root,args.port,root/'preserved-snapshot',list(range(1,successor+1)))
            evidence['checks'].append('successor stopped backup/dormant apply/refused activation/rollback; old-package snapshot refused')
            # Never downgrade the migrated working fixture. Only an isolated copy
            # is passed to the older executable to measure its refusal behavior.
            copy_home(home, refused)
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
            require(files(rollback/'data')==rollback_inventory,'rollback database/WAL/SHM copy was modified')
            process = launch(old_entry, rollback, client, log)
            verify_history(client, path, receipt, message)
            require(client.request('POST', path+'/messages', message) == (200, receipt), 'rollback idempotency')
            invoke(old_entry, 'stop', rollback); require(process.wait(timeout=10) == 0, 'rollback stop'); process = None
            verify_schema(rollback,predecessor,getattr(args,'sqlx_checksums',None))
            require(sha256(root/'preserved-snapshot/core.sqlite3') == backup_hash, 'preserved backup changed')
            require(sha256(root/'preserved-snapshot/manifest.json')==backup_manifest_hash,'preserved backup manifest changed')
            evidence['preserved_backup_sha256'] = backup_hash
            evidence['preserved_backup_manifest_sha256']=backup_manifest_hash
            evidence['checks'].append(f'old executable recovered original owner/history on untouched schema{predecessor} rollback home; backup preserved')
        evidence['status'] = 'passed'
    except BaseException as error:
        evidence['status']='failed'
        evidence['failure']={'type':type(error).__name__,'detail':str(error)}
        raise
    finally:
        try:
            if process is not None:
                stop_owned(process)
            evidence['owned_supervisor_stopped']=process is None or process.poll() is not None
        except BaseException as error:
            evidence['status']='failed'
            evidence['cleanup_failure']={'type':type(error).__name__,'detail':str(error)}
            raise
        finally:
            (root/'evidence.json').write_text(json.dumps(evidence, indent=2, sort_keys=True)+'\n')
            print('Private synthetic backup/rollback evidence retained at '+str(root))
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('old-binary', 'old-sha256', 'old-source', 'new-binary', 'new-sha256', 'new-source', 'ui', 'parent'):
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--old-package', type=Path)
    parser.add_argument('--new-package', type=Path)
    parser.add_argument('--old-schema', type=int, default=14)
    parser.add_argument('--new-schema', type=int, default=15)
    parser.add_argument('--port', required=True, type=int)
    print(json.dumps(exercise(parser.parse_args()), indent=2, sort_keys=True))
