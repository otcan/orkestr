"""Kernel TCP tuple/inode ownership, not HTTP headers or Unix peer credentials."""
import os
from pathlib import Path
from codex_bounded.trust import exists,process
from .contract import require


def socket_fds(pid,inode):
    target='socket:['+str(inode)+']';result=[]
    for path in Path('/proc',str(pid),'fd').iterdir():
        try:
            if os.readlink(path)==target:result.append(int(path.name))
        except FileNotFoundError:continue
    return result


def socket_owner(ingress,connection):
    local=connection.getsockname();remote=connection.getpeername()
    require(local[0]==remote[0]=='127.0.0.1','managed_http_loopback')
    wanted=('0100007F:'+format(remote[1],'04X'),'0100007F:'+format(local[1],'04X'))
    matches=[];uid=ingress.manager.package.executor_uid
    for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
        fields=line.split()
        if len(fields)>=10 and tuple(fields[1:3])==wanted and fields[3]=='01' and fields[7]==str(uid):
            matches.append(fields[9])
    require(len(matches)==1 and matches[0]!='0','managed_http_kernel_tuple')
    inode=matches[0];owners=[]
    for record in ingress.natives.records.values():
        proof=record['proof'];identity=proof.identity
        if proof.exited() or not exists(identity):continue
        fds=socket_fds(identity['pid'],inode)
        if not fds:continue
        for fd in fds:
            info=Path('/proc',str(identity['pid']),'fdinfo',str(fd)).read_text().splitlines()
            flags=[line.split()[1] for line in info if line.startswith('flags:')]
            require(len(flags)==1 and int(flags[0],8)&os.O_CLOEXEC,'managed_http_socket_inheritable')
        ingress.natives.actor(identity['pid'])  # original pidfd, exe, Root pipes, NNP/window.
        owners.append(record)
    require(len(owners)==1,'managed_http_original_native_owner')
    proof=owners[0]['proof'];identity=proof.identity
    # A live duplicate in another observed managed process is never accepted.
    for window in ingress.manager.windows.values():
        window.children.observe()
        for pid,start in window.children.records:
            if pid==identity['pid']:continue
            other=process(pid)
            if other and other['start']==start and other['uid']==uid:
                require(not socket_fds(pid,inode),'managed_http_shared_socket')
    require(exists(identity) and not proof.exited(),'managed_http_native_changed')
    return identity
