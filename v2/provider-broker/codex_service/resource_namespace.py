"""Root-only private mount setup before full Package validation and UID drop.

Original credential data is never read or copied. Existing Root process/child
custody owns the namespace; there is no service, general command or RPC port.
"""
import ctypes
import os
from pathlib import Path
import stat

from codex_bounded.trust import protected,private,process
from .contract import require
from .resource_contract import load,validate,selection,encoded,open_source,DIRECTORIES,READONLY
from .resource_receipt import ns,receipt_path,mount_id,verify,check_source,original_source,FORMAT
from .resource_probe import denied

CLONE_NEWNS=0x20000


def target(ctx,row):
    root=private(ctx['provider_home'],ctx['executor_uid'],True)
    relative=Path(row['target']).relative_to(root)
    fd=os.open(root,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for index,part in enumerate(relative.parts):
            directory=index+1<len(relative.parts) or row['kind'] in DIRECTORIES
            try:child=os.open(part,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            except FileNotFoundError:
                if directory:os.mkdir(part,0o700,dir_fd=fd)
                else:
                    created=os.open(part,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
                    os.close(created)
                os.chown(part,ctx['executor_uid'],ctx['executor_gid'],dir_fd=fd,follow_symlinks=False)
                child=os.open(part,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            info=os.fstat(child)
            require(info.st_uid==ctx['executor_uid'] and stat.S_IMODE(info.st_mode)==(0o700 if directory else 0o600)
                and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1),
                'resource_target_custody')
            if index+1==len(relative.parts):return fd,child,part
            os.close(fd);fd=child
    except BaseException:
        os.close(fd);raise


class Activation:
    def __init__(self,selected,ctx):
        self.selected=selected;self.ctx=ctx;self.original=None;self.mounted=[];self.receipt=None;self.receipt_identity=None
        self.homes=[];self.sources=[];self.projects=[]

    def __enter__(self):
        if self.selected is None:return self
        try:return self.activate()
        except BaseException:
            self.__exit__(None,None,None);raise

    def activate(self):
        require(os.geteuid()==0,'resource_namespace_root')
        doc=validate(load(self.selected),self.ctx)
        require(doc['receipt_directory']==self.selected['receipt_directory'],'resource_receipt_binding')
        self.doc=doc
        # Original home permissions never change. Before any private sparse
        # projection, verify the fresh executor lacks real host traversal.
        for home in doc['source_homes']:
            f=open_source(home['path'],home.get('uid',doc['source_owner_uid']),True,doc['source_homes'])
            try:
                info=os.fstat(f)
                require((info.st_dev,info.st_ino,info.st_uid,info.st_gid)==
                    (home['device'],home['inode'],home.get('uid',doc['source_owner_uid']),home['gid']),
                    'resource_source_home_changed')
            except BaseException:os.close(f);raise
            self.homes.append(dict(home,uid=home.get('uid',doc['source_owner_uid']),fd=f))
        denied(self.ctx['executor_uid'],self.ctx['executor_gid'],
            [{'path':h['path'],'operation':'traverse_home'} for h in doc['source_homes']])
        for row in doc['resources']:
            check_source(row,self.homes,process(os.getpid()),doc['source_homes'])
            source=original_source(row,self.homes,process(os.getpid()),doc['source_homes'])
            try:
                from .resource_mount import clone_source
                self.sources.append(clone_source(source))
            finally:os.close(source)
        from .resource_projects import prepare
        self.projects=prepare(self.ctx,doc)
        directory=Path(self.selected['receipt_directory'])
        if not directory.exists():
            protected(directory.parent,True);directory.mkdir(mode=0o750)
            os.chown(directory,0,self.ctx['executor_gid']);directory.chmod(0o750)
        protected(directory,True)
        require(directory.stat().st_gid==self.ctx['executor_gid'] and directory.stat().st_mode&0o777==0o750,
                'resource_receipt_directory')
        self.original=os.open('/proc/self/ns/mnt',os.O_RDONLY|os.O_CLOEXEC)
        parent=ns('mnt');libc=ctypes.CDLL(None,use_errno=True)
        require(libc.unshare(CLONE_NEWNS)==0,'resource_unshare')
        require(libc.mount(None,b'/',None,(1<<18)|(1<<14),None)==0,'resource_private_propagation')
        from .resource_projects import install
        projected=install(self.ctx,doc,self.projects,self.mounted)
        targets=[]
        for row,source in zip(doc['resources'],self.sources):
            parentfd,placeholder,name=target(self.ctx,row)
            try:
                from .resource_mount import attach
                attach(source,placeholder,row['uid'],row['gid'],self.ctx['executor_uid'],
                       self.ctx['executor_gid'],row['kind'] in READONLY,row['kind']!='toolchain',tree=source)
                mounted=os.open(name,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parentfd)
                self.mounted.append(mounted)
                targets.append({'target':row['target'],'mount_id':mount_id(mounted)})
            finally:
                os.close(parentfd);os.close(placeholder)
        checks=[{'path':str(self.ctx['home']),'operation':'read'},*doc['denials']]
        denied(self.ctx['executor_uid'],self.ctx['executor_gid'],checks)
        denied(self.ctx['authority_uid'],self.ctx['authority_gid'],[
            {'path':row['target'],'operation':'read'} for row in doc['resources'] if row['kind'] not in READONLY])
        denied(self.ctx['authority_uid'],self.ctx['authority_gid'],[
            {'path':row['path'],'operation':'read'} for row in projected]+
            [{'path':row['workspace'],'operation':'read'} for row in self.ctx.get('native_workspaces',[])])
        value=dict(format=FORMAT,contract=doc,creator=process(os.getpid()),namespace=ns('mnt'),
                   parent_namespace=parent,user_namespace=ns('user'),targets=targets,home_lookups=self.homes,projects=projected)
        self.receipt=receipt_path(self.selected)
        fd=os.open(self.receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o440)
        try:
            os.fchown(fd,0,self.ctx['executor_gid']);os.fchmod(fd,0o440)
            with os.fdopen(fd,'wb',closefd=False) as out:
                out.write(encoded(value));out.flush();os.fsync(fd)
            self.receipt_identity=(os.fstat(fd).st_dev,os.fstat(fd).st_ino)
        finally:os.close(fd)
        verify(self.selected,self.ctx)
        return self

    def __exit__(self,*_):
        if self.selected is None:return
        errors=[]
        if self.receipt is not None:
            try:
                info=self.receipt.lstat()
                if self.receipt_identity is not None and (info.st_dev,info.st_ino)==self.receipt_identity:self.receipt.unlink()
            except FileNotFoundError:pass
            except BaseException:errors.append('resource_receipt_cleanup')
        libc=ctypes.CDLL(None,use_errno=True)
        for fd in reversed(self.mounted):
            if libc.umount2(('/proc/self/fd/'+str(fd)).encode(),2)!=0:errors.append('resource_unmount')
            os.close(fd)
        self.mounted=[]
        if self.original is not None:
            if libc.setns(self.original,CLONE_NEWNS)!=0:errors.append('resource_namespace_restore')
            os.close(self.original);self.original=None
        for fd in [*self.sources,*[h['fd'] for h in self.homes],*[p[k] for p in self.projects for k in ('fd','tree')]]:
            os.close(fd)
        self.sources=[];self.homes=[];self.projects=[]
        require(not errors,'resource_cleanup')
