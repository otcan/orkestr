"""Read-only nonsensitive Root namespace attestation, consumable after UID drop."""
import hashlib
import json
import os
from pathlib import Path
import stat

from codex_bounded.trust import process,protected,metadata
from .contract import require
from .resource_contract import (encoded,selection,validate,open_source,DIRECTORIES,READONLY)

FORMAT='orkestr-resource-namespace-receipt-v1'


def ns(name):
    info=os.stat('/proc/self/ns/'+name);return [info.st_dev,info.st_ino]


def receipt_path(selected):
    selection(selected)
    return Path(selected['receipt_directory'])/('mount-'+str(ns('mnt')[1])+'.json')


def mount_id(fd):
    lines=Path('/proc/self/fdinfo',str(fd)).read_text().splitlines()
    return int(next(line.split()[1] for line in lines if line.startswith('mnt_id:')))


def options(mid,target=None):
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields=line.split()
        if int(fields[0])==mid:
            actual=fields[4]
            for escaped,decoded in ((r'\040',' '),(r'\011','\t'),(r'\012','\n'),(r'\134','\\')):
                actual=actual.replace(escaped,decoded)
            require(target is None or actual==target,'resource_mount_target')
            return set(fields[5].split(','))
    require(False,'resource_mount_missing')


def original_source(row,lookups=(),creator=None,homes=()):
    source=Path(row['source'])
    selected=next((h for h in lookups if Path(h['path']) in source.parents),None)
    if selected is None:return open_source(source,row['uid'],row['kind'] in DIRECTORIES,homes)
    require(creator is not None and process(creator['pid'])==creator and creator['uid']==0,
            'resource_original_owner_lost')
    fd=os.open(f"/proc/{creator['pid']}/fd/{selected['fd']}",os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        require((info.st_dev,info.st_ino,info.st_uid,info.st_gid)==
                (selected['device'],selected['inode'],selected['uid'],selected['gid']),
                'resource_original_home_lost')
        parts=source.relative_to(selected['path']).parts
        for index,part in enumerate(parts):
            child=os.open(part,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            os.close(fd);fd=child;info=os.fstat(fd)
            directory=index+1<len(parts) or row['kind'] in DIRECTORIES
            require(info.st_uid in (0,row['uid'],selected['uid']) and not info.st_mode&0o002
                and (stat.S_ISDIR(info.st_mode) if directory else
                     stat.S_ISREG(info.st_mode) and info.st_nlink==1),'resource_original_custody')
        result=fd;fd=None;return result
    finally:
        if fd is not None:os.close(fd)


def check_source(row,lookups=(),creator=None,homes=()):
    fd=original_source(row,lookups,creator,homes)
    try:
        info=os.fstat(fd)
        require((info.st_dev,info.st_ino,info.st_uid,info.st_gid)==
                (row['device'],row['inode'],row['uid'],row['gid']),'resource_source_changed')
        if row['kind'] not in READONLY:
            require(stat.S_IMODE(info.st_mode)==(0o700 if row['kind'] in DIRECTORIES else 0o600),
                    'resource_source_private_mode')
        return info
    finally:os.close(fd)


def verify(selected,ctx):
    if selected is None:return None
    p=protected(receipt_path(selected));fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        require(info.st_gid==ctx['executor_gid'] and stat.S_IMODE(info.st_mode)==0o440
                and info.st_size<=262144,'resource_receipt_custody')
        raw=os.read(fd,262145)
        value=json.loads(raw)
        require(len(raw)==info.st_size and set(value)=={'format','contract','creator','namespace',
            'parent_namespace','user_namespace','targets','home_lookups','projects'} and value['format']==FORMAT
            and value['namespace']==ns('mnt') and value['namespace']!=value['parent_namespace']
            and value['user_namespace']==ns('user'),'resource_namespace_required')
        doc=value['contract'];validate(doc,ctx)
        require(hashlib.sha256(encoded(doc)).hexdigest()==selected['sha256']
                and doc['receipt_directory']==selected['receipt_directory'],'resource_receipt_binding')
        creator=process(value['creator']['pid'])
        require(creator==value['creator'] and creator['uid']==0,'resource_namespace_owner_lost')
        require(type(value['targets']) is list and len(value['targets'])==len(doc['resources']),
                'resource_receipt_targets')
        for row,target in zip(doc['resources'],value['targets']):
            require(set(target)=={'target','mount_id'} and target['target']==row['target'],
                    'resource_target_binding')
            if os.geteuid()==ctx['authority_uid']:
                flags=options(target['mount_id'],row['target'])
                required={'nosuid','nodev'}
                if row['kind']!='toolchain':required.add('noexec')
                if row['kind'] in READONLY:required.add('ro')
                require(required<=flags,'resource_mount_flags')
                continue  # Core must not traverse private executor auth.
            f=os.open(row['target'],os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                meta=os.fstat(f);mid=mount_id(f)
                require((meta.st_dev,meta.st_ino,meta.st_uid,meta.st_gid)==
                    (row['device'],row['inode'],ctx['executor_uid'] if row['uid']!=0 else 0,
                     ctx['executor_gid'] if row['uid']!=0 else row['gid'])
                    and mid==target['mount_id'],'resource_target_identity')
                flags=options(mid,row['target'])
                required={'nosuid','nodev'}
                if row['kind']!='toolchain':required.add('noexec')
                if row['kind'] in READONLY:required.add('ro')
                require(required<=flags,'resource_mount_flags')
            finally:os.close(f)
            if os.geteuid()==0:check_source(row,value['home_lookups'],creator,doc['source_homes'])
        require(type(value['home_lookups']) is list and len(value['home_lookups'])==len(doc['source_homes']),
                'resource_home_lookup_set')
        for home,lookup in zip(doc['source_homes'],value['home_lookups']):
            require(set(lookup)=={'path','device','inode','uid','gid','fd'} and
                all(lookup[k]==home[k] for k in ('path','device','inode','gid')) and
                lookup['uid']==home.get('uid',doc['source_owner_uid']) and type(lookup['fd']) is int
                and lookup['fd']>2,'resource_home_lookup_binding')
        from .resource_projects import verify_projects
        verify_projects(value['projects'],ctx,value['home_lookups'],creator,doc['source_homes'])
        return value
    finally:os.close(fd)


def verify_package(package):
    selected=package.runtime.get('resource_namespace')
    if selected is None:return None
    from .resource_contract import context
    claude=metadata(package.root/'claude-private.json') if 'claude' in package.beta else None
    return verify(selected,context(package.runtime,package.beta,package.profile,claude,package.root))
