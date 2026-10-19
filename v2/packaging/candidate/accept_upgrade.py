#!/usr/bin/env python3
"""Verify exact paired upgrade inputs; execute only with --execute in owned state.

No builds or downloads. Reuses original native packages and their versions.
Backward open occurs only on the existing harness's disposable refusal copy.
"""
import argparse
import hashlib
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


SCHEMA35_INVENTORY = '66c9b7bac0991274ff462f2cb04b43ca0edc71eade81b92d32cf0fbdcd98711c'
SCHEMA36_INVENTORY = '3037e742dd4578ab3a1e886cc69eed0ba7a7f2340250434301dc3b9582b91d7b'
SCHEMA34_INVENTORY = '2c9fa817bc66fdf87d8c15253e7394b08a69ebbacaea3ae0733ae631709e24b4'
SCHEMA33_INVENTORY = '24430c423063e077633458198512834c603758c005136f15ba6d21557e0a3faf'
SCHEMA31_INVENTORY = '4b7535910df4a0351e6984d26bc0b892a46fa318432e9d6c73ca114683cd180c'


def schema_version(candidate):
    migrations=candidate['schema']['migrations']
    receipt.require(all(re.fullmatch(r'[0-9]{4}_[a-z0-9_]+\.sql',name) and re.fullmatch(r'[0-9a-f]{64}',value)
                        for name,value in migrations.items()),'exact migration inventory required')
    versions=sorted(int(name.split('_')[0]) for name in migrations)
    receipt.require(versions==list(range(1,len(versions)+1)),'contiguous source migrations required')
    return len(versions)


def source_inventory(directory, expected):
    paths=sorted(directory.glob('*.sql'))
    receipt.require(paths and all(path.is_file() and not path.is_symlink() for path in paths),
                    'regular exact Core migration sources required')
    actual={path.name:receipt.sha(path) for path in paths}
    schema_version({'schema':{'migrations':actual}})
    receipt.require(actual==expected,'Core migration source inventory mismatch')
    return receipt.digest(actual)


def sqlx_inventory(directory, expected):
    result={}
    for name,digest in expected.items():
        path=directory/name
        receipt.require(path.is_file() and not path.is_symlink(),'regular Core migration source required')
        data=path.read_bytes()
        receipt.require(hashlib.sha256(data).hexdigest()==digest,'Core migration changed while preparing SQLx checksum')
        result[str(int(name.split('_')[0]))]=hashlib.sha384(data).hexdigest()
    return result


def prepare(old, new, old_source, new_source, old_sha, new_sha, successor=24, migrations=None):
    old_value=package_candidate.verify(old,historical=True);new_value=package_candidate.verify(new)
    for root,value,source,pin in ((old,old_value,old_source,old_sha),(new,new_value,new_source,new_sha)):
        receipt.require(re.fullmatch(r'[0-9a-f]{40}',source) and value['source_commit']==source,'exact candidate source mismatch')
        receipt.require(re.fullmatch(r'[0-9a-f]{64}',pin) and receipt.sha(root/'native/server/orkestr-v2-server')==pin,'pinned candidate binary mismatch')
    predecessor=schema_version(old_value)
    receipt.require(schema_version(new_value)==successor,'successor schema differs from requested target')
    inventory_digest=source_inventory(migrations,new_value['schema']['migrations']) if migrations is not None else None
    sqlx_checksums=sqlx_inventory(migrations,new_value['schema']['migrations']) if migrations is not None else None
    receipt.require(successor not in (28,31,33,34,35,36) or bool(sqlx_checksums),'schema28/31/33/34/35/36 requires exact Core sources via migrations-dir')
    if successor==31:
        receipt.require(inventory_digest==SCHEMA31_INVENTORY,
                        'schema31 requires exact reviewed Core413 source inventory; later migrations not admitted')
    if successor==33:
        receipt.require(inventory_digest==SCHEMA33_INVENTORY,
                        'schema33 requires exact reviewed Core941 source inventory; later migrations not admitted')
    if successor==34:
        receipt.require(inventory_digest==SCHEMA34_INVENTORY,
                        'schema34 requires exact published Core63366 source inventory')
    if successor in (35,36):
        receipt.require(inventory_digest=={35:SCHEMA35_INVENTORY,36:SCHEMA36_INVENTORY}[successor],
                        'schema35/36 requires exact published Core006cca source inventory')
    admitted=True
    try:
        cross_revision.migration_edge(predecessor,successor)
    except RuntimeError:
        # Inspection of forthcoming Core sources is useful, but never admits execution.
        receipt.require(predecessor in (14,17,31,33) and successor>24 and inventory_digest is not None,
                        'unsupported migration edge; exact forthcoming Core inventory required for inspection only')
        admitted=False
    receipt.require(old_source!=new_source and old_sha!=new_sha,'distinct revision/artifact required')
    prior=old_value['schema']['migrations'];current=new_value['schema']['migrations']
    receipt.require(all(current.get(name)==digest for name,digest in prior.items()),'historical migration checksum changed')
    return {'status':'prepared_only_unexecuted' if admitted else 'pending_core_edge_admission',
            'execution_edge_admitted':admitted,'core_source_inventory_sha256':inventory_digest,
            'sqlx_checksums':sqlx_checksums,'old_source':old_source,'new_source':new_source,
            'predecessor_identity_scope':'retained original integrity pins; historical labels are not embedded identity qualification',
            'old_schema':predecessor,'new_schema':successor,'old_version':old_value['version'],'new_version':new_value['version'],
            'old_candidate_sha256':receipt.sha(old/'candidate.json'),'new_candidate_sha256':receipt.sha(new/'candidate.json'),
            'old_server_sha256':old_sha,'new_server_sha256':new_sha,
            'scope':'original qualified packages; populated history, successor reopen, isolated backward refusal, untouched old-home rollback',
            'unexecuted':['actual server upgrade/refusal/rollback','native and Docker fresh acceptance','candidate-gated CLI start','production soak']}


def host_target():
    receipt.require(platform.system()=='Linux' and platform.machine()=='x86_64','supported execution target is Linux x86_64 only')


def execute(plan,old,new,parent,port):
    receipt.require(plan.get('execution_edge_admitted',True),'Core migration edge not admitted; inspection only')
    host_target()
    return cross_revision.exercise(SimpleNamespace(
        old_binary=old/'native/server/orkestr-v2-server',new_binary=new/'native/server/orkestr-v2-server',
        old_sha256=plan['old_server_sha256'],new_sha256=plan['new_server_sha256'],
        old_source=plan['old_source'],new_source=plan['new_source'],
        old_schema=plan['old_schema'],new_schema=plan['new_schema'],sqlx_checksums=plan.get('sqlx_checksums'),
        old_package=old/'native',new_package=new/'native',ui=new/'native/ui',parent=parent,port=port))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('old','new'):p.add_argument('--'+name,type=Path,required=True)
    for name in ('old-source','new-source','old-sha','new-sha'):p.add_argument('--'+name,required=True)
    p.add_argument('--migrations-dir',type=Path);p.add_argument('--new-schema',type=int,default=24);p.add_argument('--execute',action='store_true')
    p.add_argument('--parent',type=Path);p.add_argument('--port',type=int)
    a=p.parse_args()
    result=prepare(a.old,a.new,a.old_source,a.new_source,a.old_sha,a.new_sha,a.new_schema,a.migrations_dir)
    if a.execute:
        receipt.require(a.parent is not None and a.port is not None,'explicit private parent and assigned port required')
        result={'preflight':result,'execution':execute(result,a.old,a.new,a.parent,a.port)}
    print(json.dumps(result,sort_keys=True,indent=2))
