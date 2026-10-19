#!/usr/bin/env python3
"""Opt-in current-schema issuer-fixture preservation; no authority issuance/dispatch.

Run only from a sealed helper export, against stopped disposable Core snapshots.
This is current-schema reopen/restore proof, never historical authority migration.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import sys

from real_package import Client, invoke, launch, require, sha256, stop_owned
from install_state import locked, package
from cross_revision import verify_schema


def database_inventory(path):
    """Read the stopped DB including retained WAL; emit hashes/counts only.

    immutable=1 is invalid here: a stopped server can leave committed WAL pages.
    Caller supplies a stable owned snapshot/copy; this never checkpoints the DB.
    """
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)) as db:
        db.execute('BEGIN')  # One read snapshot across integrity, schema and all rows.
        require(db.execute('PRAGMA integrity_check').fetchall()==[('ok',)], 'SQLite integrity failed')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'foreign key violation')
        schema=db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
        result={'schema_sha256':hashlib.sha256(repr(schema).encode()).hexdigest(), 'tables':{}}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
            quoted='"'+name.replace('"','""')+'"'
            rows=sorted(repr(row) for row in db.execute('SELECT * FROM '+quoted))
            result['tables'][name]={'rows':len(rows), 'sha256':hashlib.sha256(json.dumps(rows).encode()).hexdigest()}
        return result


def unused_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0))
        return listener.getsockname()[1]


def exercise(args):
    root=Path(args.output).absolute()
    require(not root.exists() and not root.is_symlink(), 'fresh output required')
    receipt_path=Path(args.handoff).absolute()
    require(sha256(receipt_path)==args.handoff_sha256, 'Core handoff receipt mismatch')
    handoff=json.loads(receipt_path.read_text())
    package_root,manifest=package(Path(args.package))
    require(manifest['source_commit']==handoff['package_source'], 'package source differs from Core handoff')
    binary=package_root/'server/orkestr-v2-server'
    require(sha256(binary)==args.server_sha256, 'pinned server mismatch')
    fingerprints=json.loads(Path(args.fingerprints).read_text())
    checksums={str(m['version']):m['sqlx_sha384'] for m in fingerprints['migrations']}
    require(len(checksums)==41, 'exact schema41 inventory required')
    fixtures=[]
    for fixture in handoff['fixtures']:
        source=Path(fixture['snapshot']).absolute()
        require(source.is_file() and not source.is_symlink(), 'regular stopped source snapshot required')
        require(not any(Path(str(source)+suffix).exists() for suffix in ('-wal','-shm','-journal')), 'standalone stopped snapshot required')
        require(sha256(source)==fixture['sha256'], 'source snapshot mismatch')
        fixtures.append((source,fixture['sha256'],database_inventory(source)))
    root.mkdir(mode=0o700)
    result={'scope':'current schema41 issuer-created snapshot copy/reopen/backup/dormant restore only',
            'releaseReady':False, 'source_commit':manifest['source_commit'], 'server_sha256':sha256(binary),
            'handoff_sha256':sha256(receipt_path), 'fixtures':[], 'status':'running',
            'unexecuted':['populated40 to41 migration','authority reissuance or live FD transfer','providers','production']}
    # Seal all external inputs/argv before any server or install subprocess runs.
    preflight={'argv':sys.argv, 'environment':{k:os.environ[k] for k in ('PATH','TMPDIR') if k in os.environ},
               'package_manifest_sha256':sha256(package_root/'manifest.json'),
               'package_files':manifest['files'], 'handoff_sha256':sha256(receipt_path),
               'fingerprints_sha256':sha256(Path(args.fingerprints)),
               'fixture_sha256':[digest for _,digest,_ in fixtures]}
    (root/'pre-execution.json').write_text(json.dumps(preflight,indent=2)+'\n')
    entry=package_root/'bin/orkestr-v2'
    process=None
    try:
        for index,(source,digest,before) in enumerate(fixtures):
            case=root/f'case-{index}';case.mkdir(mode=0o700)
            home=case/'home';port=unused_port();client=Client(port)
            invoke(entry,'install',home,'--package',package_root,'--port',port)
            with locked(home):
                target=home/'data/core.sqlite3'
                require(not target.exists(), 'installed target unexpectedly populated')
                shutil.copyfile(source,target);target.chmod(0o600)
                require(sha256(target)==digest, 'copy differs before reopen')
            with (case/'private-server.log').open('wb') as log:
                for _ in range(2):
                    process=launch(entry,home,client,log)
                    client.health()  # no bootstrap/login, messages, dispatcher or providers
                    invoke(entry,'stop',home)
                    require(process.wait(timeout=10)==0, 'owned server stop failed');process=None
                    verify_schema(home,41,checksums)
                    require(database_inventory(target)==before, 'all-row/schema equality changed on reopen')
            snapshot=case/'backup'
            invoke(entry,'backup',home,'--output',snapshot)
            require(database_inventory(snapshot/'core.sqlite3')==before, 'backup row/schema mismatch')
            dormant=case/'dormant'
            invoke(entry,'install',dormant,'--package',package_root,'--port',port)
            invoke(entry,'restore-apply',dormant,'--snapshot',snapshot)
            require(database_inventory(dormant/'data/core.sqlite3')==before, 'dormant restore row/schema mismatch')
            rejected=invoke(entry,'start',dormant,expected=1)
            require('dormant' in rejected.stderr,'activation must refuse dormant auth')
            require(database_inventory(dormant/'data/core.sqlite3')==before,'activation refusal changed data')
            invoke(entry,'restore-rollback',dormant)
            require(not list((dormant/'data').iterdir()),'rollback must leave fresh target empty')
            require(sha256(source)==digest, 'original source snapshot changed')
            require(not list(case.rglob('*.sock')), 'owned socket remains')
            with socket.socket() as listener:
                listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                listener.bind(('127.0.0.1',port))
            result['fixtures'].append({'index':index,'original_sha256':digest,'all_tables':before,
                'reopen_cycles':2,'backup_restore_rows_equal':True,'dormant_activation_refused':True,
                'rollback_empty':True,'source_unchanged':True,'port_released':port})
            print('fixture',index,'PASS',flush=True)
        result['status']='passed'
    except BaseException as error:
        result['status']='failed';result['failure']={'type':type(error).__name__,'detail':str(error)}
        raise
    finally:
        try:
            if process is not None:stop_owned(process)
            result['owned_supervisor_stopped']=process is None or process.poll() is not None
        except BaseException:
            result['status']='failed';result['owned_supervisor_stopped']=False
            raise
        finally:(root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('output','handoff','handoff-sha256','package','server-sha256','fingerprints'):
        parser.add_argument('--'+name,required=True)
    exercise(parser.parse_args())


if __name__=='__main__':main()
