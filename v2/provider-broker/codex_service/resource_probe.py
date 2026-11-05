"""Fixed negative kernel probes; no command, bytes or credential values cross."""
import ctypes
import errno
import json
import os
import select
import signal
import socket

from .contract import require


def denied(uid,gid,checks):
    result,writer=os.pipe2(os.O_CLOEXEC)
    child=os.fork()
    if child==0:
        try:
            os.close(result)
            for name in os.listdir('/proc/self/fd'):
                fd=int(name)
                if fd not in (0,1,2,writer):
                    try:os.close(fd)
                    except OSError:pass
            os.setgroups([]);os.setresgid(gid,gid,gid);os.setresuid(uid,uid,uid)
            require(ctypes.CDLL(None).prctl(38,1,0,0,0)==0,'resource_probe_nnp')
            answers=[]
            for item in checks:
                try:
                    operation=item['operation'];p=item['path']
                    if operation=='connect_unix':
                        with socket.socket(socket.AF_UNIX) as channel:
                            channel.settimeout(.2);channel.connect(p)
                    else:
                        if operation=='traverse_home':p=p+'/.orkestr-private-access-canary-absent'
                        flags=os.O_WRONLY if operation=='write' else os.O_RDONLY
                        fd=os.open(p,flags|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC);os.close(fd)
                    answers.append(False)
                except OSError as error:
                    answers.append(error.errno in (errno.EACCES,errno.EPERM) or
                                   error.errno==errno.ENOENT and operation!='traverse_home')
            os.write(writer,json.dumps(answers).encode());os._exit(0)
        except BaseException:os._exit(2)
    os.close(writer)
    try:
        require(select.select([result],[],[],5)[0],'resource_probe_timeout')
        raw=os.read(result,16384);_,status=os.waitpid(child,0);child=None
        values=json.loads(raw)
        require(status==0 and values==[True]*len(checks),'resource_required_denial')
        return values
    finally:
        os.close(result)
        if child is not None:
            try:os.kill(child,signal.SIGKILL)
            except ProcessLookupError:pass
            os.waitpid(child,0)
