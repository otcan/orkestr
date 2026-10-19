#!/usr/bin/env python3
"""Reviewed-plan-only genuine typed schema40 -> stamped41 disposable package probe."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import shutil
import socket
import sqlite3
import stat
import sys

# -I removes the script directory; add only this sealed, operator-pinned helper tree.
_HELPER = Path(__file__).resolve().parent
sys.path[:0] = [str(_HELPER), str(_HELPER.parent)]

from authority_preservation import database_inventory, unused_port
from real_package import Client, require, sha256, stop_owned
from isolated_runtime import invoke, launch, runtime_inventory, verify_runtime
from install_state import locked, package
from cross_revision import verify_schema
sys.path.insert(0,str(_HELPER.parents[1]/'packaging/candidate'))
import embedded_identity

MEMORY = {'memory_settings', 'memory_records', 'memory_decisions'}
NEW_OBJECTS = MEMORY | {'memory_records_owner', *('sqlite_autoindex_'+n+'_1' for n in MEMORY)}


def connect(path):
    return closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True))


def verify_baseline(path, checksums):
    inventory=database_inventory(path)
    require(not MEMORY.intersection(inventory['tables']), 'baseline must genuinely predate Memory')
    with connect(path) as db:
        rows=db.execute('SELECT version,checksum FROM _sqlx_migrations WHERE success ORDER BY version').fetchall()
        require([v for v,_ in rows]==list(range(1,41)), 'baseline must be genuine schema40')
        require({str(v):bytes(c).hex() for v,c in rows}=={str(v):checksums[str(v)] for v in range(1,41)}, 'baseline SQLx mismatch')


def compare_upgrade(before, after, checksums):
    """Compare all old rows/columns/DDL; only SQLx41 and empty Memory are new."""
    old_inventory=database_inventory(before); new_inventory=database_inventory(after)
    old_tables=old_inventory['tables'];new_tables=new_inventory['tables']
    require(not MEMORY.intersection(old_tables), 'baseline must genuinely predate Memory')
    require(set(new_tables)==set(old_tables)|MEMORY, 'unexpected added/removed table')
    for name in old_tables:
        if name!='_sqlx_migrations':
            require(old_tables[name]==new_tables[name], 'prior table rows changed: '+name)
    require(all(new_tables[name]['rows']==0 for name in MEMORY), 'new Memory must be empty/default off')
    with connect(before) as old, connect(after) as new:
        prior=old.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
        current=new.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
        require(all(row in current for row in prior), 'prior schema object changed')
        require({row[1] for row in current if row not in prior}==NEW_OBJECTS, 'unexpected schema changes')
        prefix=old.execute('SELECT * FROM _sqlx_migrations ORDER BY version').fetchall()
        rows=new.execute('SELECT * FROM _sqlx_migrations ORDER BY version').fetchall()
        require(len(prefix)==40 and len(rows)==41 and rows[:40]==prefix, 'old SQLx rows changed')
        for db,count in ((old,40),(new,41)):
            actual={str(v):bytes(c).hex() for v,c in db.execute('SELECT version,checksum FROM _sqlx_migrations WHERE success')}
            require(actual=={str(v):checksums[str(v)] for v in range(1,count+1)}, 'exact SQLx prefix mismatch')
    return {'prior_table_count':len(old_tables), 'old_rows_columns_schema_preserved':True,
            'new_empty_memory_tables':sorted(MEMORY),'sqlx40_preserved_and41_added':True,
            'after_inventory':new_inventory}


def verify_originals(handoff):
    for item in handoff['retained_filesystem_identities']:
        path=Path(item['path']); info=path.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'retained identity became a symlink')
        require((info.st_dev,info.st_ino,info.st_uid,stat.S_IMODE(info.st_mode))==
                (item['device'],item['inode'],item['uid'],item['mode']), 'retained identity changed')
        require((item['kind']=='directory' and stat.S_ISDIR(info.st_mode)) or
                (item['kind']=='file' and stat.S_ISREG(info.st_mode)), 'retained object type changed')
        if item['sha256'] is not None:require(sha256(path)==item['sha256'], 'retained original bytes changed')
    for fixture in handoff['snapshots']:
        require(sha256(Path(fixture['snapshot']))==fixture['snapshot_sha256'], 'stopped snapshot changed')
        for name,digest in fixture['source_files'].items():
            require(sha256(Path(name))==digest, 'original DB/WAL changed')


def execute(plan_path, output):
    plan=json.loads(plan_path.read_text())
    require(plan['format']=='orkestr-genuine40-package-plan-v1', 'supported presealed plan required')
    require(not output.exists() and not output.is_symlink(), 'fresh output required')
    for name,digest in plan['input_files'].items():
        path=Path(name)
        require(path.is_file() and not path.is_symlink() and sha256(path)==digest, 'planned input changed')
    handoff=json.loads(Path(plan['handoff']).read_text())
    require(handoff['format']=='genuine40-stopped-fixtures-v1' and len(handoff['snapshots'])==3, 'three real40 fixtures required')
    verify_originals(handoff)
    package_root,manifest=package(Path(plan['package']))
    require(manifest['source_commit']==plan['source_commit'] and manifest['version']=='2.0.0-dev', 'exact development package required')
    embedded_identity.verify(package_root/'server/orkestr-v2-server',package_root/'ui',manifest['version'],plan['source_commit'])
    fingerprints=json.loads(Path(plan['fingerprints']).read_text())
    checksums={str(m['version']):m['sqlx_sha384'] for m in fingerprints['migrations']}
    require(len(checksums)==41, 'exact41 fingerprints required')
    for fixture in handoff['snapshots']:verify_baseline(Path(fixture['snapshot']),checksums)
    output.mkdir(mode=0o700)
    result={'status':'running','scope':'genuine typed root-workspace40 -> stamped41 copy-only package upgrade',
            'releaseReady':False,'plan_sha256':sha256(plan_path),'fixtures':[],
            'unexecuted':['registered linked-worker authority','old server activation/downgrade','provider dispatch','production']}
    entry=package_root/'bin/orkestr-v2';process=None
    try:
        for index,fixture in enumerate(handoff['snapshots']):
            case=output/f'case-{index}';case.mkdir(mode=0o700)
            source=Path(fixture['snapshot']);before=case/'untouched40.sqlite3'
            shutil.copyfile(source,before);before.chmod(0o400)
            require(sha256(before)==fixture['snapshot_sha256'], 'rollback copy mismatch')
            home=case/'home';port=unused_port();client=Client(port)
            invoke(entry,'install',home,'--package',package_root,'--port',port)
            target=home/'data/core.sqlite3'
            with locked(home):
                require(not target.exists(), 'fresh install unexpectedly populated')
                shutil.copyfile(before,target);target.chmod(0o600)
            invoke(entry,'backup',home,'--output',case/'preserved40')
            require(database_inventory(case/'preserved40/core.sqlite3')==database_inventory(before),'pre-upgrade backup mismatch')
            with (case/'private-server.log').open('wb') as log:
                for _ in range(2):
                    process=launch(entry,home,client,log);client.health()
                    invoke(entry,'stop',home)
                    require(process.wait(timeout=10)==0,'owned stop failed');process=None
                    verify_schema(home,41,checksums)
                    comparison=compare_upgrade(before,target,checksums)
            invoke(entry,'backup',home,'--output',case/'successor41')
            require(database_inventory(case/'successor41/core.sqlite3')==database_inventory(target),'successor backup mismatch')
            # Roll back through an empty dormant target, never by downgrading migrated data.
            for label in ('preserved40','successor41'):
                dormant=case/('dormant-'+label)
                invoke(entry,'install',dormant,'--package',package_root,'--port',port)
                invoke(entry,'restore-apply',dormant,'--snapshot',case/label)
                require(database_inventory(dormant/'data/core.sqlite3')==database_inventory(case/label/'core.sqlite3'),'dormant copy mismatch')
                refused=invoke(entry,'start',dormant,expected=1)
                require('dormant' in refused.stderr,'raw authority activation must refuse')
                require(database_inventory(dormant/'data/core.sqlite3')==database_inventory(case/label/'core.sqlite3'),'refused start changed DB')
                invoke(entry,'restore-rollback',dormant)
                require(not list((dormant/'data').iterdir()),'dormant rollback did not recover empty target')
            verify_originals(handoff)
            require(sha256(before)==fixture['snapshot_sha256'],'untouched40 rollback copy changed')
            require(not list(case.rglob('*.sock')),'owned socket remains')
            with socket.socket() as listener:
                listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);listener.bind(('127.0.0.1',port))
            result['fixtures'].append({'index':index,'source_sha256':fixture['snapshot_sha256'],
                'comparison':comparison,'reopen_cycles':2,'backup_and_dormant_both_schemas_preserved':True,
                'dormant_activation_refused':True,'rollback_empty':True,'originals_unchanged':True,'port_released':port})
            print('genuine40 fixture',index,'PASS',flush=True)
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
        finally:(output/'result.json').write_text(json.dumps(result,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',type=Path)
    parser.add_argument('--imports-only',type=Path)
    parser.add_argument('--runtime-closure',type=Path)
    parser.add_argument('--reconcile-only',action='store_true')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if args.imports_only:
        require(not args.imports_only.exists(),'fresh import inventory output required')
        args.imports_only.write_text(json.dumps(runtime_inventory(),indent=2)+'\n')
    elif args.reconcile_only:
        require(args.runtime_closure,'runtime closure required')
        verify_runtime(args.runtime_closure)
        print('isolated import reconciliation PASS')
    else:
        require(args.plan and args.output and args.runtime_closure,'sealed plan/output/runtime closure required')
        verify_runtime(args.runtime_closure)
        execute(args.plan,args.output)
