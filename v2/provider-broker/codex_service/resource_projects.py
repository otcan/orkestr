"""Exact private-namespace project/Git projections; original home stays private."""
import os
from pathlib import Path
import stat

from .contract import require
from .resource_contract import overlap
from .resource_mount import attach,empty_home,clone_source
from .workspace_custody import association,open_checked
from .workspace_acl import owner


def native_profiles(ctx,doc):
    """Only sealed conversation CWDs; these are never Worker command profiles."""
    from .managed_host import workspace_custody
    from types import SimpleNamespace
    allowed={doc['source_owner_uid'],*[h.get('uid',doc['source_owner_uid']) for h in doc['source_homes']]}
    blocked=[*ctx['protected'],ctx['provider_home'],*ctx['artifacts'],
        *[Path(row['source']) for row in doc['resources'] if row['kind'] not in ('skill','toolchain')],
        *[Path(row['path']) for row in doc['denials']]]
    blocked.extend(Path(p) for p in ctx['beta'].get('managed_host',{}).get('environment_files',[]))
    for home in doc['source_homes']:
        root=Path(home['path'])
        blocked.extend(root/name for name in ('.ssh','.config','.codex','.claude'))
    package=SimpleNamespace(home=ctx['home'],executor_uid=ctx['executor_uid'])
    writer_roots=tuple(Path(p['workspace']) for p in ctx.get('native_workspaces',[]))
    result=[]
    for profile in ctx.get('native_workspaces',[]):
        root=Path(profile['workspace'])
        require(not any(root==Path(home['path']) or root in Path(home['path']).parents for home in doc['source_homes']),
                'resource_native_whole_home')
        require(not any(overlap(root,p) for p in blocked),'resource_native_protected_overlap')
        # Outside private homes no sparse projection is needed; the existing
        # shared named-executor ACL policy still applies, including Root leaves.
        info=root.stat(follow_symlinks=False)
        require(info.st_uid in allowed or info.st_uid in (0,ctx['executor_uid']), 'resource_native_owner')
        entry={'path':str(root),'shared':True} if profile['shared'] else str(root)
        workspace_custody(package,entry)
        if not any(Path(home['path']) in root.parents for home in doc['source_homes']):continue
        require(info.st_uid in allowed,'resource_native_private_owner')
        try:git=association(root,info.st_uid,ctx['executor_uid'],ctx['executor_gid'],doc['source_homes'],allowed,writer_roots)
        except FileNotFoundError:
            # Only a genuinely absent .git marks a non-Git native CWD. A
            # missing gitdir/commondir target never becomes an implicit grant.
            fd=open_checked(root,info.st_uid,executor=ctx['executor_uid'],executor_gid=ctx['executor_gid'],ancestry=doc['source_homes'],selected_writers=allowed,writer_roots=writer_roots)
            try:
                try:os.stat('.git',dir_fd=fd,follow_symlinks=False)
                except FileNotFoundError:git=()
                else:raise
            finally:os.close(fd)
        result.append((profile,'conversation_id',info.st_uid,(root,*git),blocked,allowed,(*writer_roots,*git)))
    return result


def prepare(ctx,doc):
    result=[]
    try:
        selected=[]
        for profile in ctx['projects']:
            root=Path(profile['workspace']);project_owner=owner(profile,ctx['executor_uid'])
            if not any(Path(h['path']) in root.parents for h in doc['source_homes']):continue
            require(project_owner==doc['source_owner_uid'],'resource_project_owner')
            directories=(root,*association(root,project_owner,ctx['executor_uid'],ctx['executor_gid'],doc['source_homes']))
            selected.append((profile,'project_id',project_owner,directories,[*ctx['protected'],ctx['provider_home']],(),()))
        selected.extend(native_profiles(ctx,doc))
        for profile,key,project_owner,directories,blocked,writers,writer_roots in selected:
            for p in directories:
                if not any(Path(h['path']) in p.parents for h in doc['source_homes']):continue
                require(not any(overlap(p,q) for q in blocked),'resource_project_authority_overlap')
                f=open_checked(p,project_owner,executor=ctx['executor_uid'],executor_gid=ctx['executor_gid'],
                               ancestry=doc['source_homes'],selected_writers=writers,writer_roots=writer_roots)
                item={'path':str(p),'fd':f,'tree':None,key:profile[key]}
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
        key='project_id' if 'project_id' in project else 'conversation_id'
        receipts.append({'path':str(p),key:project[key],'device':view.st_dev,
                         'inode':view.st_ino,'uid':view.st_uid,'mount_id':mount_id(current)})
    return receipts


def git_environment(package,environment):
    """Exact selected Git roots only; do not inherit the operator's gitconfig."""
    if not getattr(package,'runtime',{}).get('resource_namespace'):return environment
    paths=sorted({p['workspace'] for p in ([package.beta['workspace_exec']]
        if 'workspace_exec' in package.beta else [])+package.beta.get('additional_workspace_exec',[])})
    from .identity import launch_context
    launch=launch_context()
    if type(launch) is dict and launch.get('owner_id')==getattr(package,'owner',None) and launch.get('role') in ('deep','fast','claude'):
        entry=package.beta.get('conversation_workspaces',{}).get(launch['conversation_id'])
        if entry is not None:paths=sorted({*paths,entry['path'] if type(entry) is dict else entry})
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
    require(type(rows) is list and len(rows)<=3*(len(ctx['projects'])+len(ctx.get('native_workspaces',[]))),'resource_project_receipts')
    ids={p['project_id'] for p in ctx['projects']}
    native_ids={p['conversation_id'] for p in ctx.get('native_workspaces',[])}
    for row in rows:
        require(type(row) is dict,'resource_project_receipt')
        key='project_id' if 'project_id' in row else 'conversation_id'
        require(type(row) is dict and set(row)=={'path',key,'device','inode','uid','mount_id'}
                and row[key] in (ids if key=='project_id' else native_ids),'resource_project_receipt')
        require({'nosuid','nodev'}<=options(row['mount_id'],row['path']),'resource_project_flags')
        if os.geteuid()==0:
            from .resource_receipt import original_source
            writers=tuple({h['uid'] for h in lookups}) if key=='conversation_id' else ()
            roots=tuple(Path(p['workspace']) for p in ctx.get('native_workspaces',[]))
            roots+=tuple(Path(p['path']) for p in rows if 'conversation_id' in p)
            original=original_source({'source':row['path'],'uid':row['uid'],'kind':'toolchain'},
                                     lookups,creator,homes,native_writers=writers,native_roots=roots,
                                     native_executor=ctx['executor_uid'])
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
