"""Narrow root-owned fresh broker launch with authenticated one-use FDs.

No caller path, environment, executable, credential or resume identity is accepted.
The caller must already be the exact authoritative server peer of this manager.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import time

from codex_bounded.trust import process, exists, protected
from .contract import require


def atomic(path,value):
    fd,name=tempfile.mkstemp(prefix='.launch-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(value,stream,sort_keys=True)
            stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        parent=os.open(path.parent,os.O_DIRECTORY)
        try:os.fsync(parent)
        finally:os.close(parent)
    finally:
        if os.path.exists(name):os.unlink(name)


class ManagedSpawn:
    """Manager-local consumed launch proof; never reconstructed from JSON."""
    def __init__(self,identity,server,manager,window,generation,role):
        self.identity=dict(identity);self.server=dict(server);self.manager=manager
        self.window=window;self.generation=generation;self.role=role;self.consumed=False


class Launcher:
    def __init__(self,package,server):
        require(os.geteuid()==0 and package.identity_split,'split_root_launcher_required')
        self.package=package;self.server=dict(server);self.children={}
        self.manager=process(os.getpid())
        require(self.manager and self.manager['uid']==0,'launch_manager_identity')
        self.directory=package.ledger_directory/'launches'
        self.directory.mkdir(mode=0o700,exist_ok=True)
        protected(self.directory,True)
        require(self.directory.stat().st_mode&0o777==0o700,'launch_journal_custody')

    def source_fds(self,descriptors):
        require(len(descriptors)==3 and len(set(descriptors))==3,'launch_descriptor_count')
        for fd,mode in zip(descriptors[:2],(os.O_RDONLY,os.O_WRONLY)):
            require(stat.S_ISFIFO(os.fstat(fd).st_mode) and
                    fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_ACCMODE==mode,'launch_stdio_type')
        with socket.socket(fileno=os.dup(descriptors[2])) as provider:
            require(provider.family==socket.AF_UNIX and provider.type==socket.SOCK_STREAM,'launch_provider_type')
            pid,uid,_=struct.unpack('3i',provider.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            require(pid==self.server['pid'] and uid==self.server['uid'] and exists(self.server),
                    'launch_provider_source')

    def launch(self,request,descriptors,register,deadline):
        require(exists(self.server) and self.server['uid']==self.package.authority_uid,'launch_server_changed')
        require(request['role'] in self.package.role_profiles and request['mode']=='fresh' and request['role'] in ('deep','fast'),
                'split_launch_mode_unsupported')
        self.source_fds(descriptors)
        frozen={key:request[key] for key in ('request_id','window_id','generation','conversation_id','role','mode')}
        frozen['server']={key:self.server[key] for key in ('pid','start','uid')}
        # One semantic fresh launch per role/window, even if a retry invents a
        # new request id after losing the response. More worker attempts require
        # an additional typed Core attempt fence, not a new arbitrary UUID.
        identity=hashlib.sha256(json.dumps({k:v for k,v in frozen.items() if k!='request_id'},sort_keys=True).encode()).hexdigest()
        path=self.directory/(identity+'.json')
        require(not path.exists(),'launch_outcome_already_claimed')
        # Bound claims per window even when launch outcomes are unknown.
        count=sum(1 for p in self.directory.glob('*.json') if
                  json.loads(p.read_text()).get('window_id')==request['window_id'])
        require(count<32,'launch_window_bound')
        record={**frozen,'state':'claimed','manager_pid':os.getpid()}
        atomic(path,record)  # a crash/lost reply never authorizes another spawn
        child=None
        receipt=None
        parent,capsule=socket.socketpair()
        inherited=[]
        try:
            payload={key:request[key] for key in ('request_id','window_id','generation','role')}
            payload.update(server_pid=self.server['pid'],server_start=self.server['start'],
                           server_uid=self.server['uid'],manager_pid=os.getpid())
            parent.sendall(json.dumps(payload).encode());parent.shutdown(socket.SHUT_WR)
            # No preexec callback in the multithreaded manager. The immutable,
            # fixed root child remaps FDs and drops privilege before broker exec.
            provider_fd=fcntl.fcntl(descriptors[2],fcntl.F_DUPFD_CLOEXEC,10)
            inherited.append(provider_fd)
            capsule_fd=fcntl.fcntl(capsule.fileno(),fcntl.F_DUPFD_CLOEXEC,10)
            inherited.append(capsule_fd)
            interpreter=str(Path('/usr/bin/python3').resolve())
            command=[interpreter,'-I','-S','-B',str(self.package.root/'codex_service/entry.py'),
                     'launch-child',str(provider_fd),str(capsule_fd),request['role'],
                     str(os.getpid()),str(self.manager['start'])]
            child=subprocess.Popen(command,stdin=descriptors[0],stdout=descriptors[1],stderr=subprocess.DEVNULL,
                                   cwd='/',env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'},
                                   pass_fds=tuple(inherited),start_new_session=True)
            while True:
                require(time.monotonic()<deadline,'launch_pause_deadline')
                current=process(child.pid)
                require(current and child.poll() is None,'launch_child_lost')
                status=Path('/proc',str(child.pid),'status').read_text()
                stopped=any(l.startswith('State:') and 'T' in l for l in status.splitlines())
                if stopped:
                    require(current['ppid']==os.getpid() and current['uid']==self.package.executor_uid and
                            any(l.startswith('NoNewPrivs:') and l.split()[1]=='1' for l in status.splitlines()),
                            'launch_executor_boundary')
                    break
                time.sleep(.002)
            receipt=ManagedSpawn(current,self.server,self.manager['pid'],request['window_id'],
                                 request['generation'],request['role'])
            # Register original pidfd/window/role ownership before continuation.
            self.children[identity]=(child,path)
            register(receipt)
            require(receipt.consumed,'launch_registration_missing')
            record.update(state='spawned',broker_pid=current['pid'],broker_start=current['start'])
            atomic(path,record)
            return {'broker_pid':current['pid'],'broker_start':current['start'],'state':'spawned'}
        except BaseException:
            record['state']='unknown'
            try:
                atomic(path,record)
            finally:
                # Before registration the trusted broker is still stopped and
                # cannot have a native child. After continuation, the window's
                # pidfd tree must be observed before any broker is killed.
                if child is not None and not (receipt and receipt.consumed):
                    child.kill();child.wait(timeout=2)
                    self.children.pop(identity,None)
            raise
        finally:
            parent.close();capsule.close()
            for fd in inherited:os.close(fd)

    def poll(self):
        for key,(child,path) in list(self.children.items()):
            code=child.poll()
            if code is not None:
                record=json.loads(path.read_text());record['exit_code']=code
                if record['state']!='unknown':record['state']='exited'
                atomic(path,record);del self.children[key]

    def close(self):
        self.poll()
        # The manager must first observe/terminate/reap each window's full owned
        # tree. Killing a broker here first could hide newly reparented natives.
        require(not self.children, 'managed_launch_children_not_reaped')
