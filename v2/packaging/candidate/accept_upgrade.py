#!/usr/bin/env python3
"""Verify exact paired upgrade inputs; execute only with --execute in owned state.

No builds or downloads. Reuses original native packages and their versions.
Backward open occurs only on the existing harness's disposable refusal copy.
"""
import argparse
import json
from pathlib import Path
import platform
import re
import sys
from types import SimpleNamespace

import package_candidate
import receipt

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'local-install/tests'))
import cross_revision


def schema_version(candidate):
    migrations=candidate['schema']['migrations']
    receipt.require(all(re.fullmatch(r'[0-9]{4}_[a-z0-9_]+\.sql',name) and re.fullmatch(r'[0-9a-f]{64}',value)
                        for name,value in migrations.items()),'exact migration inventory required')
    versions=sorted(int(name.split('_')[0]) for name in migrations)
    receipt.require(versions==list(range(1,len(versions)+1)),'contiguous source migrations required')
    return len(versions)


def prepare(old, new, old_source, new_source, old_sha, new_sha, successor=24):
    old_value=package_candidate.verify(old);new_value=package_candidate.verify(new)
    for root,value,source,pin in ((old,old_value,old_source,old_sha),(new,new_value,new_source,new_sha)):
        receipt.require(re.fullmatch(r'[0-9a-f]{40}',source) and value['source_commit']==source,'exact candidate source mismatch')
        receipt.require(re.fullmatch(r'[0-9a-f]{64}',pin) and receipt.sha(root/'native/server/orkestr-v2-server')==pin,'pinned candidate binary mismatch')
    predecessor=schema_version(old_value)
    receipt.require(schema_version(new_value)==successor,'successor schema differs from requested target')
    cross_revision.migration_edge(predecessor,successor)
    receipt.require(old_source!=new_source and old_sha!=new_sha,'distinct revision/artifact required')
    prior=old_value['schema']['migrations'];current=new_value['schema']['migrations']
    receipt.require(all(current.get(name)==digest for name,digest in prior.items()),'historical migration checksum changed')
    return {'status':'prepared_only_unexecuted','old_source':old_source,'new_source':new_source,
            'old_schema':predecessor,'new_schema':successor,'old_version':old_value['version'],'new_version':new_value['version'],
            'old_candidate_sha256':receipt.sha(old/'candidate.json'),'new_candidate_sha256':receipt.sha(new/'candidate.json'),
            'old_server_sha256':old_sha,'new_server_sha256':new_sha,
            'scope':'original qualified packages; populated history, successor reopen, isolated backward refusal, untouched old-home rollback',
            'unexecuted':['actual server upgrade/refusal/rollback','native and Docker fresh acceptance','candidate-gated CLI start','production soak']}


def host_target():
    receipt.require(platform.system()=='Linux' and platform.machine()=='x86_64','supported execution target is Linux x86_64 only')


def execute(plan,old,new,parent,port):
    host_target()
    return cross_revision.exercise(SimpleNamespace(
        old_binary=old/'native/server/orkestr-v2-server',new_binary=new/'native/server/orkestr-v2-server',
        old_sha256=plan['old_server_sha256'],new_sha256=plan['new_server_sha256'],
        old_source=plan['old_source'],new_source=plan['new_source'],
        old_schema=plan['old_schema'],new_schema=plan['new_schema'],
        old_package=old/'native',new_package=new/'native',ui=new/'native/ui',parent=parent,port=port))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('old','new'):p.add_argument('--'+name,type=Path,required=True)
    for name in ('old-source','new-source','old-sha','new-sha'):p.add_argument('--'+name,required=True)
    p.add_argument('--new-schema',type=int,default=24);p.add_argument('--execute',action='store_true')
    p.add_argument('--parent',type=Path);p.add_argument('--port',type=int)
    a=p.parse_args()
    result=prepare(a.old,a.new,a.old_source,a.new_source,a.old_sha,a.new_sha,a.new_schema)
    if a.execute:
        receipt.require(a.parent is not None and a.port is not None,'explicit private parent and assigned port required')
        result={'preflight':result,'execution':execute(result,a.old,a.new,a.parent,a.port)}
    print(json.dumps(result,sort_keys=True,indent=2))
