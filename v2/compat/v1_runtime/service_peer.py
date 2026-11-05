"""Root-published Core identity bound to the actual connected HTTP socket.

A matching port or health string grants no peer identity. The accepted reverse
TCP tuple must be held by the exact original Core process before every send.
This privileged Linux operator transport never discovers authority from labels.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import select
import stat
import threading
import time
import uuid

FORMAT='orkestr-core-http-peer-v1'
MAX_DESCRIPTOR=16384
MAX_EXECUTABLE=512*1024*1024
_HASHES={}
_HASH_LOCK=threading.Lock()


class PeerError(RuntimeError):pass


def require(value,reason):
    if not value:raise PeerError(reason)


def protected(path,directory=False):
    path=Path(path)
    require(path.is_absolute() and path.resolve(strict=True)==path,'peer_path_alias')
    for item in (path,*path.parents):
        info=item.lstat()
        require(info.st_uid==0 and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode),'peer_root_custody')
        require(item==path or stat.S_ISDIR(info.st_mode),'peer_ancestor_type')
    info=path.stat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1,'peer_object_type')
    return path


def file_hash(fd):
    before=os.fstat(fd)
    require(stat.S_ISREG(before.st_mode) and 0<before.st_size<=MAX_EXECUTABLE,'peer_executable_bound')
    key=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
    with _HASH_LOCK:cached=_HASHES.get(key)
    if cached is not None:return cached
    digest=hashlib.sha256();offset=0
    while offset<before.st_size:
        raw=os.pread(fd,min(65536,before.st_size-offset),offset)
        require(raw,'peer_executable_short_read');digest.update(raw);offset+=len(raw)
    after=os.fstat(fd)
    require(key==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'peer_executable_changed')
    result=digest.hexdigest()
    with _HASH_LOCK:
        if len(_HASHES)>=64:_HASHES.clear()
        _HASHES[key]=result
    return result


def actor(pid):
    proc=Path('/proc',str(pid));fields=(proc/'stat').read_text().rsplit(') ',1)[1].split()
    status=(proc/'status').read_text().splitlines();uids=[x.split()[1:] for x in status if x.startswith('Uid:')]
    require(len(uids)==1 and len(uids[0])==4 and len(set(uids[0]))==1,'peer_process_uid')
    return {'pid':pid,'ppid':int(fields[1]),'start':int(fields[19]),'uid':int(uids[0][1])}


def validate_actor(value):
    fields={'pid','ppid','start','uid','exe_path','exe_device','exe_inode','exe_sha256'}
    require(type(value) is dict and set(value)==fields,'peer_actor_shape')
    require(all(type(value[x]) is int and value[x]>=0 for x in ('pid','ppid','start','uid','exe_device','exe_inode')) and
            value['pid']>1 and value['start']>0 and value['exe_inode']>0,'peer_actor_identity')
    require(type(value['exe_sha256']) is str and re.fullmatch('[0-9a-f]{64}',value['exe_sha256']),'peer_executable_pin')
    protected(value['exe_path'])


def descriptor(path,owner,source,host,port):
    require(os.geteuid()==0 and hasattr(os,'pidfd_open'),'peer_privileged_linux_required')
    path=protected(path);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        require(before.st_uid==0 and stat.S_IMODE(before.st_mode)==0o400 and before.st_size<=MAX_DESCRIPTOR,'peer_descriptor_custody')
        raw=os.read(fd,MAX_DESCRIPTOR+1);after=os.fstat(fd)
        key=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
        require(len(raw)<=MAX_DESCRIPTOR and key(before)==key(after)==key(path.stat()),'peer_descriptor_changed')
    finally:os.close(fd)
    def unique(items):
        out={}
        for key,value in items:require(key not in out,'peer_duplicate_key');out[key]=value
        return out
    value=json.loads(raw,object_pairs_hook=unique)
    require(type(value) is dict and set(value)=={'format','source_commit','owner_id','endpoint','boot_id','network_namespace','manager','core'},'peer_descriptor_shape')
    require(value['format']==FORMAT and value['source_commit']==source and value['owner_id']==owner and
            str(uuid.UUID(owner))==owner,'peer_descriptor_scope')
    require(value['endpoint']=={'host':host,'port':port} and host=='127.0.0.1','peer_endpoint_scope')
    require(value['boot_id']==Path('/proc/sys/kernel/random/boot_id').read_text().strip() and
            value['network_namespace']==os.readlink('/proc/self/ns/net'),'peer_boot_or_network_changed')
    validate_actor(value['manager']);validate_actor(value['core'])
    require(value['manager']['uid']==0 and value['core']['uid']>0 and
            value['core']['ppid']==value['manager']['pid'],'peer_original_manager_relation')
    return value


class Binding:
    def __init__(self,path,owner,source,host,port,timeout=1):
        self.descriptors=[];self.socket=None;self.timeout=min(float(timeout),1.0)
        try:
            self.value=descriptor(path,owner,source,host,port)
            for name in ('manager','core'):
                self.descriptors.append(os.pidfd_open(self.value[name]['pid'],0))
            self.actors()
        except PeerError:self.close();raise
        except (OSError,ValueError,TypeError,KeyError):
            self.close();raise PeerError("peer_binding_unavailable") from None

    def actors(self):
        require(len(self.descriptors)==2,'peer_pidfd_required')
        require(not select.select(self.descriptors,[],[],0)[0],'peer_original_process_exited')
        for name in ('manager','core'):
            expected=self.value[name];current=actor(expected['pid'])
            require(all(current[x]==expected[x] for x in ('pid','ppid','start','uid')),'peer_actor_changed')
            require(os.readlink('/proc/'+str(current['pid'])+'/ns/net')==self.value['network_namespace'],'peer_actor_network_changed')
            pinned=protected(expected['exe_path']).stat()
            require((pinned.st_dev,pinned.st_ino)==(expected['exe_device'],expected['exe_inode']),'peer_executable_replaced')
            fd=os.open('/proc/'+str(current['pid'])+'/exe',os.O_RDONLY|os.O_CLOEXEC)
            try:
                actual=os.fstat(fd)
                require((actual.st_dev,actual.st_ino)==(pinned.st_dev,pinned.st_ino) and file_hash(fd)==expected['exe_sha256'],'peer_executable_changed')
            finally:os.close(fd)
        require(not select.select(self.descriptors,[],[],0)[0],'peer_original_process_exited')

    def verify(self,sock,wait=False):
        try:return self._verify(sock,wait)
        except PeerError:raise
        except (OSError,ValueError,TypeError,KeyError):raise PeerError('peer_kernel_proof_unavailable') from None

    def _verify(self,sock,wait=False):
        self.actors()
        require(sock is not None and sock.fileno()>=0,'peer_socket_missing')
        local,remote=sock.getsockname(),sock.getpeername()
        require(local[0]==remote[0]=='127.0.0.1' and remote[1]==self.value['endpoint']['port'],'peer_socket_endpoint')
        # The actual connected client socket is retained; a matching listener
        # cannot substitute for ownership of the accepted reverse connection.
        client=os.fstat(sock.fileno())
        wanted=('0100007F:'+format(remote[1],'04X'),'0100007F:'+format(local[1],'04X'))
        own=(wanted[1],wanted[0]);deadline=time.monotonic()+(self.timeout if wait else 0)
        while True:
            rows=[];client_seen=False
            for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
                fields=line.split()
                if len(fields)<10 or fields[3]!='01':continue
                if tuple(fields[1:3])==own and fields[9]==str(client.st_ino):client_seen=True
                if tuple(fields[1:3])==wanted and fields[7]==str(self.value['core']['uid']):rows.append(fields[9])
            if client_seen and len(rows)==1 and rows[0]!='0':
                owned=[]
                for fd in Path('/proc',str(self.value['core']['pid']),'fd').iterdir():
                    try:
                        if os.readlink(fd)=='socket:['+rows[0]+']':owned.append(fd)
                    except FileNotFoundError:pass
                if owned:
                    self.actors();return
            require(time.monotonic()<deadline,'peer_accepted_socket_not_original_core')
            time.sleep(.005)

    def close(self):
        for fd in self.descriptors:
            try:os.close(fd)
            except OSError:pass
        self.descriptors=[]


class Connection(http.client.HTTPConnection):
    def __init__(self,host,port,*,descriptor_path,owner,source,timeout):
        super().__init__(host,port,timeout=timeout)
        self.offered_bytes=False
        self.binding=Binding(descriptor_path,owner,source,host,port,timeout)

    def connect(self):
        try:
            super().connect();self.binding.verify(self.sock,wait=True)
        except BaseException:self.close();raise

    def send(self,data):
        require(self.sock is not None,'peer_reconnect_refused')
        self.binding.verify(self.sock)
        # HTTPConnection sends headers and body through this method separately.
        # No cookie, CSRF or key byte leaves before this exact-connection check.
        self.offered_bytes=True
        return super().send(data)

    def close(self):
        super().close()
        if getattr(self,'binding',None) is not None:self.binding.close()
