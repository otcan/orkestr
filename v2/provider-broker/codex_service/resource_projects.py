"""Exact private-namespace project/Git projections; original home stays private."""
import os
from pathlib import Path
import stat

from .contract import require
from .resource_contract import overlap
from .resource_mount import attach,empty_home,clone_source
from .workspace_custody import association,open_checked
from .workspace_acl import owner


def prepare(ctx,doc):
    result=[]
    try:
        for profile in ctx['projects']:
            root=Path(profile['workspace']);project_owner=owner(profile,ctx['executor_uid'])
            if not any(Path(h['path']) in root.parents for h in doc['source_homes']):continue
            require(project_owner==doc['source_owner_uid'],'resource_project_owner')
            directories=(root,*association(root,project_owner,ctx['executor_uid'],ctx['executor_gid'],doc['source_homes']))
            for p in directories:
                if not any(Path(h['path']) in p.parents for h in doc['source_homes']):continue
                require(not any(overlap(p,q) for q in [*ctx['protected'],ctx['provider_home']]),
                        'resource_project_authority_overlap')
                f=open_checked(p,project_owner,executor=ctx['executor_uid'],executor_gid=ctx['executor_gid'],
                               ancestry=doc['source_homes'])
                item={'path':str(p),'fd':f,'tree':None,'project_id':profile['project_id']}
                result.append(item);item['tree']=clone_source(f)
        # One common Git directory can contain other selected Git leaves. A bind
        # of that exact common root already exposes those required children.
        keep=[]
        for item in sorted(result,key=lambda r:len(Path(r['path']).parts)):
            p=Path(item['path'])
            if any(Path(other['path'])==p or Path(other['path']) in p.parents for other in keep):
                os.close(item['fd']);os.close(item['tree'])
            else:keep.append(item)
        return keep

    except BaseException:
        for item in result:
            for key in ('fd','tree'):
                if item[key] is not None:
                    try:os.close(item[key])
                    except OSError:pass
        raise


def install(ctx,doc,projects,mounted):
    if not projects:return []
    active=[h for h in doc['source_homes'] if any(Path(h['path']) in Path(p['path']).parents for p in projects)]
    for artifact in ctx['artifacts']:
        require(not any(Path(h['path'])==artifact or Path(h['path']) in artifact.parents for h in active),
                'resource_artifact_in_private_home')
    for home in active:
        fd=os.open(home['path'],os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:empty_home(fd,ctx['executor_uid'])
        finally:os.close(fd)
        mounted.append(os.open(home['path'],os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC))
    receipts=[]
    for project in projects:
        p=Path(project['path']);home=next(Path(h['path']) for h in active if Path(h['path']) in p.parents)
        parent=os.open(home,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            for part in p.relative_to(home).parts:
                try:os.mkdir(part,0o711,dir_fd=parent)
                except FileExistsError:pass
                child=os.open(part,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
                require(os.fstat(child).st_uid==0,'resource_project_target_parent')
                os.close(parent);parent=child
            attach(project['fd'],parent,0,0,ctx['executor_uid'],ctx['executor_gid'],
                   readonly=False,noexec=False,idmap=False,tree=project['tree'])
        finally:os.close(parent)
        current=os.open(p,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        mounted.append(current)
        original=os.fstat(project['fd']);view=os.fstat(current)
        require((original.st_dev,original.st_ino,original.st_uid)==(view.st_dev,view.st_ino,view.st_uid),
                'resource_project_identity')
        from .resource_receipt import mount_id
        receipts.append({'path':str(p),'project_id':project['project_id'],'device':view.st_dev,
                         'inode':view.st_ino,'uid':view.st_uid,'mount_id':mount_id(current)})
    return receipts


def git_environment(package,environment):
    """Exact selected Git roots only; do not inherit the operator's gitconfig."""
    if not getattr(package,'runtime',{}).get('resource_namespace'):return environment
    paths=sorted({p['workspace'] for p in ([package.beta['workspace_exec']]
        if 'workspace_exec' in package.beta else [])+package.beta.get('additional_workspace_exec',[])})
    if not paths:return environment
    result=dict(environment)
    count=result.get('GIT_CONFIG_COUNT','0')
    require(type(count) is str and count.isdecimal() and int(count)<=128,'resource_git_config_count')
    start=int(count)
    for index,p in enumerate(paths,start):
        result['GIT_CONFIG_KEY_'+str(index)]='safe.directory';result['GIT_CONFIG_VALUE_'+str(index)]=p
    result['GIT_CONFIG_COUNT']=str(start+len(paths))
    return result


def verify_projects(rows,ctx,lookups=(),creator=None,homes=()):
    from .resource_receipt import mount_id,options
    require(type(rows) is list and len(rows)<=3*len(ctx['projects']),'resource_project_receipts')
    ids={p['project_id'] for p in ctx['projects']}
    for row in rows:
        require(type(row) is dict and set(row)=={'path','project_id','device','inode','uid','mount_id'}
                and row['project_id'] in ids,'resource_project_receipt')
        require({'nosuid','nodev'}<=options(row['mount_id'],row['path']),'resource_project_flags')
        if os.geteuid()==0:
            from .resource_receipt import original_source
            original=original_source({'source':row['path'],'uid':row['uid'],'kind':'toolchain'},lookups,creator,homes)
            try:
                meta=os.fstat(original)
                require((meta.st_dev,meta.st_ino,meta.st_uid)==(row['device'],row['inode'],row['uid']),
                        'resource_project_source_replaced')
            finally:os.close(original)
        if os.geteuid()==ctx['authority_uid']:continue
        fd=os.open(row['path'],os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            info=os.fstat(fd)
            require((info.st_dev,info.st_ino,info.st_uid,mount_id(fd))==
                (row['device'],row['inode'],row['uid'],row['mount_id']),'resource_project_replaced')
        finally:os.close(fd)
