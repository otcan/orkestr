"""Root-manager child bootstrap; never setuid, never callable as a root service.

Only immutable package code runs while root. It maps root-selected inherited
FDs, drops every supplementary group and UID, sets NNP, and execs the fixed role.
"""
import ctypes
import os
from pathlib import Path
import signal
import socket
import struct
from .contract import require
from .identity import enforce_no_new_privs


def main(package, arguments):
    from codex_bounded.trust import process
    require(os.geteuid() == 0 and package.identity_split and len(arguments) == 8,
            'manager_launch_bootstrap')
    provider, capsule, resume, role, mode, parent, start, native_io = arguments
    require(len(native_io.split(",")) == 4 and all(v.isdigit() for v in native_io.split(",")), "native_io_fields")
    native_io = list(map(int, native_io.split(",")))
    from .native_io import validate as validate_native_io, SLOTS
    validate_native_io(native_io)
    require(all(v.isdigit() for v in (provider, capsule, resume, parent, start)), 'launch_descriptor_fields')
    provider, capsule, resume, parent, start = map(int, (provider, capsule, resume, parent, start))
    require(mode in ('fresh','resume') and ((resume==0) if mode=='fresh' else
            resume>6 and resume not in (provider,capsule) and not role.startswith('worker-')),'launch_resume_descriptor')
    require(provider > 6 and capsule > 6 and provider != capsule and (role in package.role_profiles or role=='claude' and package.claude is not None),
            'launch_descriptor_scope')
    identity = process(parent)
    require(parent == os.getppid() and identity and identity['start'] == start and identity['uid'] == 0,
            'launch_manager_incarnation')
    with socket.socket(fileno=os.dup(capsule)) as proof:
        pid, uid, _ = struct.unpack('3i', proof.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(pid == parent and uid == 0, 'launch_manager_capsule')
    require(len(set(native_io + [provider, capsule] + ([resume] if resume else []))) == 6 + bool(resume),
            "native_io_descriptor_alias")
    # Duplicate above destinations first so descriptor remapping never clobbers
    # another source; no arbitrary source file or executable is opened.
    import fcntl
    a=fcntl.fcntl(provider,fcntl.F_DUPFD_CLOEXEC,10)
    b=fcntl.fcntl(capsule,fcntl.F_DUPFD_CLOEXEC,10)
    c=fcntl.fcntl(resume,fcntl.F_DUPFD_CLOEXEC,10) if resume else None
    io_copies = [fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,20) for fd in native_io]
    os.dup2(a,3,inheritable=True);os.dup2(b,6,inheritable=True)
    if c is not None:os.dup2(c,4,inheritable=True)
    os.close(a);os.close(b)
    for source,target in zip(io_copies,SLOTS): os.dup2(source,target,inheritable=True)
    os.closerange(11,1048576)
    os.closerange(5,6)
    if c is None:os.closerange(4,5)
    os.setgroups([])
    os.setgid(package.executor_gid)
    os.setuid(package.executor_uid)
    enforce_no_new_privs()
    status=Path('/proc/self/status').read_text().splitlines()
    require(all(int(line.split()[1],16)==0 for line in status
                if line.split(':',1)[0] in ('CapInh','CapPrm','CapEff','CapAmb')),
            'executor_capabilities_retained')
    libc=ctypes.CDLL(None,use_errno=True)
    require(libc.prctl(1,signal.SIGKILL,0,0,0)==0 and os.getppid()==parent,
            'launch_parent_death')
    interpreter=str(Path('/usr/bin/python3').resolve())
    operation='resume-owned-session' if mode=='resume' else 'open-owned-session'
    mode='broker' if role=='deep' else 'broker-'+role
    os.execve(interpreter,[interpreter,'-I','-S','-B',str(package.root/'codex_service/entry.py'),
                          mode,operation,'--protocol','orkestr-v2-provider-broker-v1'],
              {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'})
