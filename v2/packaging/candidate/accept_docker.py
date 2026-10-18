#!/usr/bin/env python3
"""Opt-in owned prebuilt-image acceptance; outer reviewed probe always tears down.

No build, pull, host mounts, providers, credential import or daemon changes.
Requires explicit reviewed image ID and Compose digest, plus paired candidate.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit
import package_candidate
import receipt
import soak

DOCKER = Path(__file__).resolve().parents[1]/'docker'
sys.path.insert(0,str(DOCKER))
import probe
import recovery_probe
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'local-install'))
from helper import Client, smoke


def checkpoint(context, project, image, manifest):
    command=('compose','--project-name',project,'--file',str(context/'compose.json'))
    cid=probe.run(*command,'ps','--quiet','server')
    token=probe.run('exec',cid,'python3','-B','-c',
                    "from pathlib import Path;print(Path('/state/control/bootstrap.token').read_text())")
    client=Client(urlsplit(manifest['origin']).port)
    smoke(client,token)
    for name,wanted in manifest['files'].items():
        if name.startswith('ui/'):
            with client.opener.open(manifest['origin']+'/'+name[3:],timeout=3) as response:
                receipt.require(hashlib.sha256(response.read()).hexdigest()==wanted,'served container asset mismatch')
    actual=json.loads(probe.run('exec',cid,'python3','-B','-c',
        "import sqlite3,json;c=sqlite3.connect('file:/state/data/core.sqlite3?mode=ro',uri=True);"
        "print(json.dumps([r[0] for r in c.execute('SELECT version FROM _sqlx_migrations WHERE success ORDER BY version')]));c.close()"))
    expected=sorted(int(name.split('_')[0]) for name in manifest['release_metadata']['schema']['migrations'])
    receipt.require(actual==expected,'container schema differs from source metadata')
    latency=soak.measure(manifest['origin'],5,.1,2)
    receipt.require(latency['successes']==5,'container health samples failed')
    probe.run(*command,'stop','server')
    recovery=recovery_probe.exercise(context,cid)
    return {'scope':'owned same-source trusted HTTP/control plane; no providers/executor activation',
            'source_commit':manifest['release_metadata']['source_commit'],
            'schema_versions':actual,'health_latency':latency,'dormant_recovery':recovery,
            'all_ui_asset_hashes_verified':True}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate',type=Path,required=True)
    p.add_argument('--reviewed-image-id',required=True)
    p.add_argument('--reviewed-compose-sha256',required=True)
    p.add_argument('--sudo',action='store_true');p.add_argument('--output',required=True)
    a=p.parse_args()
    package_candidate.verify(a.candidate)
    if a.sudo:probe.DOCKER=['sudo','-n','docker']
    with open(a.output,'x') as stream:
        value=probe.probe(a.candidate/'docker',a.reviewed_image_id,a.reviewed_compose_sha256,acceptance=checkpoint)
        value['candidate_manifest_sha256']=receipt.sha(a.candidate/'candidate.json')
        json.dump(value,stream,sort_keys=True,indent=2);stream.write('\n')
