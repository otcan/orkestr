"""Fixed authority-UID owned Child proxy. No provider bytes or commands parsed.

Runtime retains/reaps this real Child. The root manager separately retains the
actual executor broker and sends its bounded terminal status on private FD6.
"""
import ctypes
import os
import signal
import socket
import struct
from .contract import require
from .identity import enforce_no_new_privs


def main(package,role,arguments):
    workspace = ['open-owned-workspace-worker-session','--protocol','orkestr-v2-provider-broker-v1']
    require(package.identity_split and os.geteuid()==package.authority_uid and
            (role in package.role_profiles or role=='claude' and package.claude is not None)
            and arguments in [['open-owned-session','--protocol','orkestr-v2-provider-broker-v1'],
                              ['resume-owned-session','--protocol','orkestr-v2-provider-broker-v1'],
                              *([workspace] if role.startswith('worker-') else [])]
            and (arguments[0]!='resume-owned-session' or not role.startswith('worker-')),
            'split_proxy_mode')
    enforce_no_new_privs()
    with socket.socket(fileno=6) as lifecycle:
        require(lifecycle.family==socket.AF_UNIX and lifecycle.type==socket.SOCK_STREAM,
                'proxy_lifecycle_type')
        parent=os.getppid()
        pid,uid,_=struct.unpack('3i',lifecycle.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        libc=ctypes.CDLL(None,use_errno=True)
        require(pid==parent and uid==package.authority_uid and
                libc.prctl(1,signal.SIGKILL,0,0,0)==0 and os.getppid()==parent,
                'proxy_server_parent')
        def cancel(_number,_frame):
            try:lifecycle.sendall(b'cancel')
            except OSError:pass
        signal.signal(signal.SIGTERM,cancel);signal.signal(signal.SIGINT,cancel)
        # The root manager validates this original stopped proxy before it
        # duplicates its source-created FDs into a different-UID real broker.
        os.kill(os.getpid(),signal.SIGSTOP)
        for fd in (0,1,3,4):
            try:os.close(fd)
            except OSError:pass
        lifecycle.settimeout(1)
        data=bytearray()
        while len(data)<=32:
            try:chunk=lifecycle.recv(33-len(data))
            except socket.timeout:
                require(os.getppid()==parent,'proxy_server_lost')
                continue
            if not chunk:break
            data.extend(chunk)
        require(data.startswith(b'exit:') and data.endswith(b'\n') and len(data)<=32,
                'proxy_unknown_broker_outcome')
        value=bytes(data[5:-1])
        require(value.isdigit() and 0<=int(value)<=255,'proxy_exit_status')
        return int(value)
