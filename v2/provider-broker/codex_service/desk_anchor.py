"""Fixed per-operation Root subreaper. No shell, inherited secrets or caller argv.

An anonymous Root-parent socket authorizes one protected mapping. The helper
never inherits that socket. Only ECHILD after actual reap proves cleanup.
"""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import time
from codex_bounded.trust import digest,exists,process,protected
from .contract import require
from .ownership import Adopted,Process,Vanished,MAX_CHILDREN


class Tree(Adopted):
    def __init__(self):
        # This is one Root-owned operation anchor, not a split service identity
        # configuration. Reuse kernel custody mechanics without inventing zero
        # authority/executor UIDs or weakening the service's identity contract.
        require(os.geteuid()==0,'desk_tree_root')
        selected=ctypes.c_int()
        require(ctypes.CDLL(None).prctl(37,ctypes.byref(selected),0,0,0)==0 and selected.value==1,
                'desk_tree_subreaper')
        self.parent=process(os.getpid());self.records={}
        require(self.parent and self.parent['uid']==0,'desk_tree_identity')

    def _remember(self,identity):
        # This per-operation anchor owns kernel descendants even if a protected
        # helper legitimately drops UID. No same-UID or caller-PID discovery.
        key=(identity['pid'],identity['start'])
        if key not in self.records:
            require(len(self.records)<MAX_CHILDREN,'desk_child_bound')
            try:self.records[key]=Process(identity,any_uid=True)
            except Vanished:return False
            return True
        return False


def main(package,arguments):
    require(os.geteuid()==0 and package.identity_split and len(arguments)==3,'desk_anchor_scope')
    fd,parent,start=map(int,arguments)
    identity=process(parent)
    require(fd>2 and parent==os.getppid() and identity and identity['uid']==0 and identity['start']==start,
            'desk_anchor_parent')
    with socket.socket(fileno=fd) as channel:
        pid,uid,_=struct.unpack('3i',channel.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        require(pid==parent and uid==0,'desk_anchor_socket')
        channel.settimeout(1)
        def read(size):
            data=bytearray()
            while len(data)<size:
                part=channel.recv(size-len(data));require(part,'desk_anchor_eof');data.extend(part)
            return bytes(data)
        length=struct.unpack('!I',read(4))[0]
        require(0<length<=8192,'desk_anchor_bound')
        payload=read(length)
        value=json.loads(payload)
        require(type(value) is dict and set(value)=={'helper','sha256','conversation_id','desk','site','duration_ms'},'desk_anchor_fields')
        from .desk_operations import mapping
        value=mapping(value)
        helper=protected(value['helper']);require(digest(helper)==value['sha256'],'desk_helper_pin')
        require(ctypes.CDLL(None).prctl(36,1,0,0,0)==0,'desk_anchor_subreaper')
        tree=Tree()
        cancelled=False;child=None;record=None;clean=False;code=None
        deadline=time.monotonic()+value['duration_ms']/1000
        channel.setblocking(False)
        def stop(_signal,_frame):
            nonlocal cancelled
            cancelled=True
        signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
        try:
            child=subprocess.Popen([str(helper),'--conversation',value['conversation_id'],'--desk',value['desk'],value['site']],
                cwd='/',env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'},
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,process_group=0)
            original=process(child.pid);require(original and original['ppid']==os.getpid(),'desk_owned_helper')
            record=Process(original,any_uid=True);known={(original['pid'],original['start'])}
            while child.poll() is None:
                if not exists(identity) or time.monotonic()>=deadline:cancelled=True
                try:
                    received=channel.recv(16)
                    if received in (b'',b'cancel'):cancelled=True
                    elif received:cancelled=True
                except BlockingIOError:pass
                tree.capture(known)
                for pid in Adopted.children(original):
                    descendant=process(pid)
                    if descendant and descendant['ppid']==original['pid']:tree._remember(descendant)
                tree.observe()
                if cancelled:
                    record.send(signal.SIGKILL)
                    for descendant in tree.records.values():descendant.send(signal.SIGKILL)
                time.sleep(.01)
            code=child.wait()
            # Once the helper is actually reaped, all previously unobserved
            # detached descendants become this anchor's own kernel children.
            until=time.monotonic()+3
            while time.monotonic()<until:
                tree.drain(set(),seconds=.05)
                try:
                    pid,_=os.waitpid(-1,os.WNOHANG)
                except ChildProcessError:
                    clean=True;break
                if pid==0:time.sleep(.01)
            require(clean and all(p.gone() for p in tree.records.values()),'desk_cleanup_unknown')
            payload=json.dumps({'cleanup':True,'cancelled':cancelled,'helper_exit':code}).encode()
            channel.settimeout(1);channel.sendall(struct.pack('!I',len(payload))+payload)
            return 0
        finally:
            if child is not None and child.poll() is None:child.kill();child.wait()
            if record:record.close()
            if not clean:tree.drain(set(),seconds=.25)
            tree.close()
