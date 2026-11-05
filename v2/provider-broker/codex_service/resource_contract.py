"""Closed Root-selected canonical business resources; never provider/caller input."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from codex_bounded.trust import protected
from .contract import identifier, require
from .identity import bind

FORMAT='orkestr-resource-namespace-v1'
KINDS={'codex_auth','codex_lock','gog_store','claude_account','skill','toolchain'}
DIRECTORIES=KINDS-{'codex_auth','codex_lock'}
READONLY={'skill','toolchain'}


def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


def path(value):
    require(type(value) is str and value.startswith('/') and value!='/' and len(value)<=4096
            and not any(ord(c)<32 for c in value)
            and all(p not in ('','.','..') for p in value.split('/')[1:]),'resource_path')
    return Path(value)


def overlap(a,b):return a==b or a in b.parents or b in a.parents


def integer(value,zero=False):return type(value) is int and (0 if zero else 1)<=value<2**63


def unique(pairs):
    value={}
    for key,item in pairs:
        require(key not in value,'resource_duplicate_key');value[key]=item
    return value


def selection(value):
    require(type(value) is dict and set(value)=={'path','sha256','receipt_directory'} and
            type(value['sha256']) is str and re.fullmatch('[0-9a-f]{64}',value['sha256']),
            'resource_selection')
    path(value['path']);path(value['receipt_directory']);return value


def load(value):
    selection(value);p=protected(value['path'])
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        require(stat.S_IMODE(info.st_mode)==0o400 and info.st_size<=131072,'resource_contract_custody')
        raw=os.read(fd,131073)
        require(len(raw)==info.st_size and hashlib.sha256(raw).hexdigest()==value['sha256'],
                'resource_contract_pin')
        doc=json.loads(raw,object_pairs_hook=unique)
        require(raw==encoded(doc),'resource_contract_canonical_json')
        return doc
    finally:os.close(fd)


def context(runtime,beta,profile,claude=None,package_root=None):
    require('host_full_access' not in beta,'resource_no_legacy_host_profile')
    identity=bind(runtime)
    require(identity['split'],'resource_split_required')
    result=dict(identity,owner_id=identifier(runtime['owner_id']),home=path(runtime['home']),
        provider_home=path(identity['provider_home']),endpoint=path(runtime['endpoint_directory']),
        auth=path(profile['auth_file']),claude=path(claude['account']) if claude else None,
        projects=([beta['workspace_exec']] if 'workspace_exec' in beta else [])+beta.get('additional_workspace_exec',[]),
        beta=beta)
    result['protected']=[path(runtime[k]) for k in ('home','bootstrap_file','ledger_directory','endpoint_directory')]
    if package_root is not None:result['protected'].append(path(str(package_root)))
    environments=[]
    if type(beta.get('managed_host')) is dict:environments.append(beta['managed_host']['environment'])
    for project in result['projects']:
        env=project.get('trusted',{}).get('managed_executor',{}).get('environment')
        if env is not None:environments.append(env)
    if claude and type(claude.get('managed_host')) is dict:
        environments.append(claude['managed_host']['environment'])
    result['environments']=environments
    return result


def validate(doc,ctx):
    require(type(doc) is dict and set(doc)=={'format','owner_id','authority_uid','authority_gid',
        'executor_uid','executor_gid','source_owner_uid','source_homes','resources','denials','receipt_directory'} and
        doc['format']==FORMAT and doc['owner_id']==ctx['owner_id'],'resource_contract_fields')
    for key in ('authority_uid','authority_gid','executor_uid','executor_gid'):
        require(integer(doc[key]) and doc[key]==ctx[key],'resource_identity_binding')
    old=doc['source_owner_uid'];new=ctx['executor_uid'];group=ctx['executor_gid']
    require(integer(old) and old not in (new,ctx['authority_uid']),'resource_source_identity')
    homes=doc['source_homes'];rows=doc['resources'];denials=doc['denials']
    require(type(homes) is list and 0<len(homes)<=8 and type(rows) is list and 0<len(rows)<=64
            and type(denials) is list and len(denials)<=32,'resource_contract_bound')
    receipt=path(doc['receipt_directory'])
    require(not any(overlap(receipt,q) for q in [*ctx['protected'],ctx['provider_home']]),'resource_receipt_scope')
    private=[]
    for item in homes:
        require(type(item) is dict and set(item)=={'path','device','inode','gid'}
                and integer(item['device'],True) and integer(item['inode']) and integer(item['gid'],True)
                and item['gid']!=group,'resource_home_fields')
        p=path(item['path'])
        require(not any(overlap(p,q) for q in [*private,*ctx['protected'],ctx['provider_home']]),
                'resource_home_overlap')
        private.append(p)
    auth=0;lock=0;claudes=0;targets=[];sources=[]
    for item in rows:
        require(type(item) is dict and set(item)-{'project_id'}=={'kind','source','target','uid','gid','device','inode'}
                and item['kind'] in KINDS and all(integer(item[k],k in ('uid','gid','device'))
                for k in ('uid','gid','device','inode')),'resource_row_fields')
        kind=item['kind'];src=path(item['source']);dst=path(item['target'])
        require(item['uid'] in (old,0) and (item['uid']!=0 or kind in READONLY),
                'resource_source_owner')
        require(not any(overlap(src,q) or overlap(dst,q) for q in ctx['protected']),
                'resource_authority_overlap')
        require(not any(overlap(dst,q) for q in targets),'resource_target_overlap')
        require(not any(overlap(src,q) for q in sources),'resource_source_alias')
        require(not overlap(src,receipt) and not overlap(dst,receipt),'resource_receipt_overlap')
        targets.append(dst);sources.append(src)
        require('project_id' not in item and ctx['provider_home'] in dst.parents,
                'resource_target_scope')
        require(not any(src==p or src==p/'.ssh' or p/'.ssh' in src.parents
                or src==p/'.config' or src==p/'.claude' or p/'.claude' in src.parents
                or (src==p/'.codex' or p/'.codex' in src.parents)
                   and kind not in ('codex_auth','codex_lock','skill')
                for p in private),'resource_private_home_scope')
        if kind not in READONLY:require(item['gid']!=group,'resource_legacy_group')
        if kind=='skill':require(src.name=='skills' or src.parent.name=='skills','resource_skill_leaf')
        if kind=='codex_auth':
            require(src.name==dst.name=='auth.json' and dst==ctx['auth'],'resource_codex_auth');auth+=1
        elif kind=='codex_lock':
            require(src.name==dst.name=='auth.lock' and dst==ctx['auth'].parent/'auth.lock',
                    'resource_codex_lock');lock+=1
        elif kind=='gog_store':
            allowed={path(env.get('XDG_CONFIG_HOME',str(Path(env['HOME'])/'.config')))/'gogcli'
                     for env in ctx['environments']}
            require(src.name==dst.name=='gogcli' and dst in allowed,'resource_gog_binding')
        elif kind=='claude_account':
            require(ctx['claude'] is not None and dst==ctx['claude'],'resource_claude_binding');claudes+=1
    require(auth==1 and lock<=1 and claudes==int(ctx['claude'] is not None),'resource_account_set')
    for item in denials:
        require(type(item) is dict and set(item)=={'path','operation'} and
                item['operation'] in ('read','write','connect_unix'),'resource_denial_fields')
        p=path(item['path'])
        require(not any(overlap(p,q) for q in targets),'resource_denial_overlap')
    return doc


def open_source(value,uid,directory):
    """Root walks original sources without links; never opens credential bytes."""
    p=path(str(value));fd=os.open('/',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        for index,part in enumerate(p.parts[1:]):
            last=index==len(p.parts)-2
            child=os.open(part,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            os.close(fd);fd=child;info=os.fstat(fd)
            require(not stat.S_ISLNK(info.st_mode) and info.st_uid in (0,uid)
                    and not info.st_mode&0o002,'resource_source_custody')
            require(stat.S_ISDIR(info.st_mode) if not last or directory else
                    stat.S_ISREG(info.st_mode) and info.st_nlink==1,'resource_source_type')
        return fd
    except BaseException:
        os.close(fd);raise
