"""Linux detached idmapped mounts; source and target are retained directory/file FDs."""
import ctypes
import os
from pathlib import Path
import platform
import select
import signal
import struct

from .contract import require

LIBC=ctypes.CDLL(None,use_errno=True)
LIBC.syscall.restype=ctypes.c_long


class Attributes(ctypes.Structure):
    _fields_=[('attr_set',ctypes.c_uint64),('attr_clr',ctypes.c_uint64),
              ('propagation',ctypes.c_uint64),('userns_fd',ctypes.c_uint64)]


def mapping(uid,gid,target_uid,target_gid):
    """Return a userns FD; fixed helper has no command/data or surviving process."""
    ready,notify=os.pipe2(os.O_CLOEXEC);release,finish=os.pipe2(os.O_CLOEXEC)
    parent=os.getpid();child=os.fork()
    if child==0:
        try:
            for name in os.listdir('/proc/self/fd'):
                fd=int(name)
                if fd not in (0,1,2,notify,release):
                    try:os.close(fd)
                    except OSError:pass
            require(LIBC.prctl(1,signal.SIGKILL,0,0,0)==0 and os.getppid()==parent,
                    'resource_mapping_parent')
            require(LIBC.unshare(0x10000000)==0,'resource_mapping_userns')
            os.write(notify,b'1');require(os.read(release,1)==b'1','resource_mapping_release')
            os._exit(0)
        except BaseException:os._exit(2)
    os.close(notify);os.close(release);namespace=None
    try:
        require(select.select([ready],[],[],3)[0] and os.read(ready,1)==b'1','resource_mapping_ready')
        root=Path('/proc')/str(child)
        (root/'setgroups').write_text('deny')
        (root/'uid_map').write_text(f'{uid} {target_uid} 1\n')
        (root/'gid_map').write_text(f'{gid} {target_gid} 1\n')
        namespace=os.open(root/'ns/user',os.O_RDONLY|os.O_CLOEXEC)
        os.write(finish,b'1');_,status=os.waitpid(child,0);child=None
        require(status==0,'resource_mapping_child')
        result=namespace;namespace=None;return result
    finally:
        if namespace is not None:os.close(namespace)
        os.close(ready);os.close(finish)
        if child is not None:
            try:os.kill(child,signal.SIGKILL)
            except ProcessLookupError:pass
            os.waitpid(child,0)


def attach(source,target,uid,gid,target_uid,target_gid,readonly=False,noexec=True,idmap=True,tree=None):
    require(os.geteuid()==0 and platform.machine() in ('x86_64','aarch64'),'resource_mount_host')
    userns=mapping(uid,gid,target_uid,target_gid) if uid!=0 and idmap else None
    detached=clone_source(source) if tree is None else os.dup(tree)
    try:
        require(detached>=0,'resource_open_tree')
        attributes=Attributes((0x100000 if userns is not None else 0)|2|4|(1 if readonly else 0)|(8 if noexec else 0),0,0,userns or 0)
        require(LIBC.syscall(442,detached,b'',0x1000,ctypes.byref(attributes),ctypes.sizeof(attributes))==0,
                'resource_mount_setattr')
        require(LIBC.syscall(429,detached,b'',target,b'',0x4|0x40)==0,'resource_move_mount')
    finally:
        if detached>=0:os.close(detached)
        if userns is not None:os.close(userns)


def empty_home(target,executor):
    """Attach a new sparse tmpfs over a pinned home, without changing its inode."""
    fs=LIBC.syscall(430,b'tmpfs',1);mount=None
    try:
        require(fs>=0,'resource_home_fsopen')
        for key,value in ((b'mode',b'0700'),(b'size',b'4m')):
            require(LIBC.syscall(431,fs,1,key,value,0)==0,'resource_home_fsconfig')
        require(LIBC.syscall(431,fs,6,None,None,0)==0,'resource_home_create')
        mount=LIBC.syscall(432,fs,1,2|4)  # Project scripts remain executable.
        require(mount>=0,'resource_home_fsmount')
        # Apply private traversal rights while detached. Core shares the IPC
        # group but receives no path access to original world-readable projects.
        root=os.open('.',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=mount)
        try:
            missing=0xffffffff
            entries=((1,7,missing),(2,1,executor),(4,0,missing),(16,1,missing),(32,0,missing))
            acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
            os.setxattr(root,'system.posix_acl_access',acl)
        finally:os.close(root)
        require(LIBC.syscall(429,mount,b'',target,b'',0x4|0x40)==0,'resource_home_attach')
    finally:
        if mount is not None and mount>=0:os.close(mount)
        if fs>=0:os.close(fs)


def clone_source(source):
    result=LIBC.syscall(428,source,b'',0x1000|1|os.O_CLOEXEC)
    require(result>=0,'resource_open_tree')
    return result
