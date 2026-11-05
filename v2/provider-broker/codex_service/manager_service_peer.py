"""Publish the original Root manager/Core child identities for operator clients.

The authority source is the manager's retained Popen and exact launch identity,
never a process label, port scan, health string, or reconstructed child claim.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import stat
import time
import uuid

from codex_bounded.trust import protected
from .contract import require

FORMAT='orkestr-core-http-peer-v1'


def actor(pid):
    proc=Path('/proc',str(pid));fields=(proc/'stat').read_text().rsplit(') ',1)[1].split()
    status=(proc/'status').read_text().splitlines();uids=[x.split()[1:] for x in status if x.startswith('Uid:')]
    require(len(uids)==1 and len(uids[0])==4 and len(set(uids[0]))==1,'http_peer_actor_uid')
    return {'pid':pid,'ppid':int(fields[1]),'start':int(fields[19]),'uid':int(uids[0][1])}


def executable(path):
    path=protected(path);before=path.stat();require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and
        0<before.st_size<=512*1024*1024,'http_peer_executable_bound')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        digest=hashlib.sha256()
        while raw:=os.read(fd,65536):digest.update(raw)
        after=os.fstat(fd)
        key=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
        require(key(before)==key(after)==key(path.stat()),'http_peer_executable_changed')
        return {'exe_path':str(path),'exe_device':before.st_dev,'exe_inode':before.st_ino,'exe_sha256':digest.hexdigest()}
    finally:os.close(fd)


def alive(value):
    try:
        current=actor(value['pid'])
        return all(current[key]==value[key] for key in ('pid','start','uid'))
    except (OSError,ValueError,KeyError):return False


class Publisher:
    def __init__(self,package,child,original,timeout=10):
        require(os.geteuid()==0 and child.pid==original['pid'] and child.poll() is None,'http_peer_original_child')
        self.package,self.child,self.original=package,child,dict(original)
        self.path=package.control.parent/'service-peer.json'
        self.lock=self.pidfd=None;self.owned=None;self.raw=None
        self.parent=protected(self.path.parent,True)
        self.parent_identity=(self.parent.stat().st_dev,self.parent.stat().st_ino)
        try:
            self.lock=os.open(self.parent/'service-peer.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
            info=os.fstat(self.lock)
            require(info.st_uid==0 and stat.S_ISREG(info.st_mode) and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600,'http_peer_lock_custody')
            fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.pidfd=os.pidfd_open(child.pid,0)
            expected=executable(package.root/'server');deadline=time.monotonic()+timeout
            while True:
                self.check_child()
                actual=Path('/proc',str(child.pid),'exe').stat()
                if (actual.st_dev,actual.st_ino)==(expected['exe_device'],expected['exe_inode']):break
                require(time.monotonic()<deadline,'http_peer_server_exec_deadline');time.sleep(.005)
            manager=actor(os.getpid());require(manager['uid']==0,'http_peer_root_manager')
            manager.update(executable(Path('/proc/self/exe').resolve(strict=True)))
            core=actor(child.pid);core.update(expected)
            require(core['uid']==package.authority_uid and core['uid']>0 and core['ppid']==manager['pid'],'http_peer_core_relationship')
            source=package.manifest['source_commit'];require(len(source)==40,'http_peer_source')
            value={'format':FORMAT,'source_commit':source,'owner_id':package.owner,
                   'endpoint':{'host':'127.0.0.1','port':package.runtime['port']},
                   'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                   'network_namespace':os.readlink('/proc/self/ns/net'),'manager':manager,'core':core}
            require(os.readlink('/proc/'+str(child.pid)+'/ns/net')==value['network_namespace'],'http_peer_core_network')
            self.publish(value);self.check_child()
        except BaseException:
            self.close();raise

    def check_child(self):
        require(self.child.poll() is None and not select.select([self.pidfd],[],[],0)[0],'http_peer_original_child_exited')
        current=actor(self.child.pid)
        require(all(current[k]==self.original[k] for k in ('pid','start','uid')) and current['ppid']==os.getpid(),'http_peer_original_child_changed')

    def parent_unchanged(self):
        protected(self.parent,True);info=self.parent.stat()
        require((info.st_dev,info.st_ino)==self.parent_identity,'http_peer_parent_changed')

    def publish(self,value):
        self.parent_unchanged()
        if self.path.exists() or self.path.is_symlink():
            protected(self.path);info=self.path.stat()
            require(stat.S_IMODE(info.st_mode)==0o400 and info.st_nlink==1 and info.st_size<=16384,'http_peer_previous_custody')
            previous=json.loads(self.path.read_bytes())
            require(previous.get('format')==FORMAT and not alive(previous['manager']) and not alive(previous['core']),'http_peer_previous_actor_live')
        raw=json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n'
        pending=self.parent/('.service-peer-'+uuid.uuid4().hex)
        try:
            fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o400)
            try:
                os.fchmod(fd,0o400);view=memoryview(raw)
                while view:
                    count=os.write(fd,view);require(count>0,'http_peer_short_write');view=view[count:]
                os.fsync(fd)
            finally:os.close(fd)
            self.parent_unchanged();os.replace(pending,self.path)
            fd=os.open(self.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
            info=self.path.stat();self.owned=(info.st_dev,info.st_ino);self.raw=raw
        finally:
            if pending.exists():pending.unlink()

    def close(self):
        try:
            if self.owned is not None:
                self.parent_unchanged();info=self.path.lstat()
                require((info.st_dev,info.st_ino)==self.owned and self.path.read_bytes()==self.raw,'http_peer_close_cas')
                self.path.unlink()
                fd=os.open(self.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try:os.fsync(fd)
                finally:os.close(fd)
                self.owned=None
        finally:
            for name in ('pidfd','lock'):
                fd=getattr(self,name)
                if fd is not None:os.close(fd);setattr(self,name,None)
