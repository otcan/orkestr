#!/usr/bin/env python3
"""Explicit fresh-state native acceptance of a verified candidate; no builds.

Starting the server intentionally initializes only new synthetic state. Existing
homes are never accepted. Failed private probes retain diagnostics for review.
"""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import shutil
import package_candidate
import receipt
import soak

LOCAL = Path(__file__).resolve().parents[2]/'local-install'
sys.path.insert(0,str(LOCAL/'tests'))
from real_package import Client, invoke, launch, stop_owned, smoke, verify_history


def exercise(candidate, parent, port):
    manifest=package_candidate.verify(candidate)
    entry=candidate/'native/bin/orkestr-v2'
    receipt.require(parent.is_absolute() and parent.is_dir(), 'existing private parent required')
    root=Path(tempfile.mkdtemp(prefix='v2-candidate-probe-',dir=parent))
    home=root/'home'; process=None
    result={'source_commit':manifest['source_commit'],'version':manifest['version'],
            'candidate_manifest_sha256':receipt.sha(candidate/'candidate.json'),
            'scope':'Linux x86_64 same-source fresh native package; explicit initialization, no existing-state migration',
            'checks':[],'unexecuted':['Browser interaction','Providers','Cross-version upgrade','Dormant activation','Executor isolation']}
    passed=False
    try:
        invoke(entry,'install',home,'--package',candidate/'native','--port',port)
        with (root/'private.log').open('wb') as log:
            client=Client(port);process=launch(entry,home,client,log)
            path,admission,message=smoke(client,(home/'control/bootstrap.token').read_text())
            # Every UI asset is checked, rather than merely the HTML shell.
            base=client.base.removesuffix('/api/v2')
            for name,info in json.loads((candidate/'paired-artifacts.json').read_text())['web']['files'].items():
                import hashlib
                with client.opener.open(base+'/'+name,timeout=3) as response:
                    body=response.read()
                receipt.require(hashlib.sha256(body).hexdigest()==info['sha256'],'served asset mismatch')
            rejected=invoke(entry,'backup',home,'--output',root/'busy-backup',expected=1)
            receipt.require('busy' in rejected.stderr and not (root/'busy-backup').exists(),'live backup not refused')
            result['health_latency']=soak.measure(base,5,0.1,2)
            receipt.require(result['health_latency']['successes']==5,'health sampling failed')
            invoke(entry,'stop',home);receipt.require(process.wait(timeout=10)==0,'stop failed');process=None
            invoke(entry,'backup',home,'--output',root/'snapshot')
            db=root/'snapshot/core.sqlite3'
            with closing(sqlite3.connect(db.as_uri()+'?mode=ro&immutable=1',uri=True)) as connection:
                actual=[r[0] for r in connection.execute('SELECT version FROM _sqlx_migrations WHERE success ORDER BY version')]
                expected=sorted(int(name.split('_')[0]) for name in manifest['schema']['migrations'])
                receipt.require(actual==expected,'actual initialized schema differs from declared source')
            result['schema_versions']=actual;result['backup_sha256']=receipt.sha(db)
            target=root/'dormant'
            invoke(entry,'install',target,'--package',candidate/'native','--port',port)
            invoke(entry,'restore-apply',target,'--snapshot',root/'snapshot')
            rejected=invoke(entry,'start',target,expected=1)
            receipt.require('dormant' in rejected.stderr,'dormant activation not refused')
            invoke(entry,'restore-rollback',target)
            receipt.require(not list((target/'data').iterdir()),'dormant rollback target not empty')
            process=launch(entry,home,client,log);verify_history(client,path,admission,message)
            invoke(entry,'stop',home);receipt.require(process.wait(timeout=10)==0,'restart stop failed');process=None
            result['checks']=['Exact package install and source/schema metadata','Synthetic auth/history/idempotency',
                              'All UI asset hashes','Live backup exclusion','Five read-only health latency samples',
                              'Stopped SQLite backup and exact migration inventory','Same-package dormant apply/refusal/rollback',
                              'Original-home restart/history']
        result['status']='passed';passed=True
    finally:
        if process is not None:stop_owned(process)
        if passed:shutil.rmtree(root)
        else:print('Failed private probe retained: '+str(root),file=sys.stderr)
    result['owned_home_removed']=not root.exists()
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate',type=Path,required=True);p.add_argument('--parent',type=Path,required=True)
    p.add_argument('--port',type=int,required=True);p.add_argument('--output',required=True)
    a=p.parse_args()
    # Reserve output before starting any child, refusing existing evidence.
    with open(a.output,'x') as stream:
        json.dump(exercise(a.candidate,a.parent,a.port),stream,sort_keys=True,indent=2);stream.write('\n')
