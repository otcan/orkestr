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

from codex_bounded.trust import process, exists, protected, digest
from .contract import require,setup_scope,preferences


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
    def __init__(self,identity,server,manager,window,generation,role,proxy):
        self.identity=dict(identity);self.server=dict(server);self.manager=manager
        self.window=window;self.generation=generation;self.role=role;self.proxy=dict(proxy);self.consumed=False


class Handle:
    def __init__(self,child,path,lifecycle,proxy,window,generation,broker):
        self.child,self.path,self.lifecycle,self.proxy=child,path,lifecycle,proxy
        self.window,self.generation=window,generation
        self.cancelled=False
        self.broker=dict(broker)


class Launcher:
    def __init__(self,package,server):
        require(os.geteuid()==0 and package.identity_split,'split_root_launcher_required')
        self.package=package;self.server=dict(server);self.children={};self.proxies={}
        self.manager=process(os.getpid())
        require(self.manager and self.manager['uid']==0,'launch_manager_identity')
        self.directory=package.ledger_directory/'launches'
        self.directory.mkdir(mode=0o700,exist_ok=True)
        protected(self.directory,True)
        require(self.directory.stat().st_mode&0o777==0o700,'launch_journal_custody')

    def source_fds(self,descriptors):
        require(len(descriptors)==4 and len(set(descriptors))==4,'launch_descriptor_count')
        require(len({(os.fstat(fd).st_dev,os.fstat(fd).st_ino) for fd in descriptors})==4,'launch_descriptor_alias')
        for fd,mode in zip(descriptors[:2],(os.O_RDONLY,os.O_WRONLY)):
            require(stat.S_ISFIFO(os.fstat(fd).st_mode) and
                    fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_ACCMODE==mode,'launch_stdio_type')
        for fd in descriptors[2:]:
            with socket.socket(fileno=os.dup(fd)) as provider:
                require(provider.family==socket.AF_UNIX and provider.type==socket.SOCK_STREAM,'launch_provider_type')
                pid,uid,_=struct.unpack('3i',provider.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                require(pid==self.server['pid'] and uid==self.server['uid'] and exists(self.server),
                        'launch_provider_source')

    def launch(self,request,descriptors,register,deadline):
        setup_scope(request['setup'],request['role'],request['owner_id'],request['conversation_id'])
        preferences(request['preferences'],request['role'])
        require(exists(self.server) and self.server['uid']==self.package.authority_uid,'launch_server_changed')
        require((request['role'] in self.package.role_profiles or request['role']=='claude' and self.package.claude is not None) and request['mode']=='fresh',
                'split_launch_mode_unsupported')
        self.source_fds(descriptors)
        proxy=process(request['proxy_pid'])
        require(proxy and proxy['start']==request['proxy_start'] and proxy['ppid']==self.server['pid']
                and proxy['uid']==self.package.authority_uid,'launch_proxy_incarnation')
        expected=[str(Path('/usr/bin/python3').resolve()).encode(),b'-I',b'-S',b'-B',
                  bytes(self.package.root/'codex_service/entry.py'),
                  ('broker' if request['role']=='deep' else 'broker-'+request['role']).encode(),
                  b'open-owned-session',b'--protocol',b'orkestr-v2-provider-broker-v1']
        proc=Path('/proc',str(proxy['pid']))
        # The source retains its original Child immediately after spawn. Its
        # immutable entry still needs time to validate the package and stop;
        # no launch is claimed and no broker starts before that exact stop.
        while True:
            require(exists(proxy) and time.monotonic()<deadline,'launch_proxy_source')
            status=(proc/'status').read_text()
            stopped=any(l.startswith('State:') and 'T' in l for l in status.splitlines())
            if stopped:
                require((proc/'cmdline').read_bytes().split(b'\0')[:-1]==expected and
                        any(l.startswith('NoNewPrivs:') and l.split()[1]=='1' for l in status.splitlines()),
                        'launch_proxy_source')
                break
            time.sleep(.002)
        from .ownership import Process
        frozen={key:request[key] for key in ('request_id','window_id','generation','conversation_id','role','mode','setup')}
        frozen['server']={key:self.server[key] for key in ('pid','start','uid')}
        # One semantic launch per exact Core-issued setup in this slot/window.
        # The opaque Runtime metadata locator attests the original setup fence;
        # changing only request UUID can never retry a lost/unknown outcome.
        identity=hashlib.sha256(json.dumps({k:v for k,v in frozen.items() if k!='request_id'},sort_keys=True).encode()).hexdigest()
        path=self.directory/(identity+'.json')
        require(not path.exists(),'launch_outcome_already_claimed')
        records=[json.loads(p.read_text()) for p in self.directory.glob('*.json')]
        require(not any(record.get('proxy_pid')==proxy['pid'] and record.get('proxy_start')==proxy['start']
                        for record in records),'launch_proxy_already_claimed')
        # Bound claims per window even when launch outcomes are unknown.
        count=sum(1 for record in records if record.get('window_id')==request['window_id'])
        require(count<32,'launch_window_bound')
        record={**frozen,'state':'claimed','manager_pid':os.getpid(),
                'preferences':request['preferences'],
                'proxy_pid':proxy['pid'],'proxy_start':proxy['start']}
        atomic(path,record)  # a crash/lost reply never authorizes another spawn
        proxy_proof=Process(proxy)
        self.proxies[(proxy['pid'],proxy['start'])]=proxy_proof
        lifecycle=socket.socket(fileno=os.dup(descriptors[3]));lifecycle.setblocking(False)
        child=None
        receipt=None
        parent,capsule=socket.socketpair()
        inherited=[]
        try:
            from .attachment_exports import initialize_conversation
            initialize_conversation(self.package,request['conversation_id'])
            payload={key:request[key] for key in ('request_id','window_id','generation','role','setup','preferences')}
            payload.update(server_pid=self.server['pid'],server_start=self.server['start'],
                           server_uid=self.server['uid'],manager_pid=os.getpid(),
                           manager_start=self.manager['start'],owner_id=self.package.owner,
                           conversation_id=request['conversation_id'],
                           manifest_sha256=digest(self.package.root/'manifest.json'))
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
                            (Path('/proc',str(child.pid),'cmdline').read_bytes().split(b'\0')[:-1])==expected and
                            Path('/proc',str(child.pid),'exe').resolve()==Path('/usr/bin/python3').resolve() and
                            any(l.startswith('NoNewPrivs:') and l.split()[1]=='1' for l in status.splitlines()),
                            'launch_executor_boundary')
                    break
                time.sleep(.002)
            receipt=ManagedSpawn(current,self.server,self.manager['pid'],request['window_id'],
                                 request['generation'],request['role'],proxy)
            # Register original pidfd/window/role ownership before continuation.
            self.children[identity]=Handle(child,path,lifecycle,proxy_proof,request["window_id"],request["generation"],current)
            register(receipt)
            require(receipt.consumed,'launch_registration_missing')
            record.update(state='spawned',broker_pid=current['pid'],broker_start=current['start'])
            atomic(path,record)
            require(exists(proxy),'launch_proxy_changed')
            proxy_proof.send(signal.SIGCONT)
            return {'broker_pid':current['pid'],'broker_start':current['start'],'state':'spawned',
                    'proxy_pid':proxy['pid'],'proxy_start':proxy['start'],'role':request['role'],
                    'window_id':request['window_id'],'generation':request['generation']}
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
                    lifecycle.close()
            raise
        finally:
            parent.close();capsule.close()
            for fd in inherited:os.close(fd)

    def poll(self,released=lambda _window,_generation,_broker:False):
        cancelled=[]
        for key,handle in list(self.children.items()):
            child,path=handle.child,handle.path
            try:
                command=handle.lifecycle.recv(16)
                if command==b'' or command:
                    if not handle.cancelled:cancelled.append((handle.window,handle.generation))
                    handle.cancelled=True
            except BlockingIOError:pass
            except OSError:
                if not handle.cancelled:cancelled.append((handle.window,handle.generation))
                handle.cancelled=True
            if not handle.cancelled and handle.proxy.exited():
                cancelled.append((handle.window,handle.generation));handle.cancelled=True
            code=child.poll()
            if code is not None:
                record=json.loads(path.read_text())
                if record['state']=='unknown' and 'exit_code' not in record:
                    record['exit_code']=code;atomic(path,record)
            if code is not None and code<0 and not handle.cancelled:
                cancelled.append((handle.window,handle.generation));handle.cancelled=True
                record=json.loads(path.read_text());record.update(state='unknown',exit_code=code);atomic(path,record)
            if code is not None and released(handle.window,handle.generation,handle.broker):
                record=json.loads(path.read_text());record['exit_code']=code
                if handle.cancelled:record['state']='quarantined'
                elif record['state']!='unknown':record['state']='exited'
                atomic(path,record)
                status=125 if handle.cancelled else code if code>=0 else min(255,128-code)
                try:handle.lifecycle.sendall(('exit:%d\n'%status).encode())
                except OSError:pass
                handle.lifecycle.close();del self.children[key]
        for key,proxy in list(self.proxies.items()):
            if proxy.exited():
                current=process(proxy.identity['pid'])
                if current and current['start']==proxy.identity['start'] and current['ppid']==os.getpid():
                    try:os.waitid(os.P_PIDFD,proxy.fd,os.WEXITED|os.WNOHANG)
                    except ChildProcessError:pass
            if proxy.gone():proxy.close();del self.proxies[key]
        return cancelled

    def fault(self):
        """Persist global association loss without inventing a role result."""
        for handle in self.children.values():
            handle.cancelled=True
            record=json.loads(handle.path.read_text());record['state']='unknown'
            code=handle.child.poll()
            if code is not None:record['exit_code']=code
            atomic(handle.path,record)

    def close(self):
        # A caller supplies actual owned-tree release proof via poll first.
        require(not self.children, 'managed_launch_children_not_reaped')
        if not exists(self.server):
            require(not self.proxies,'managed_proxy_not_reaped')
        for proxy in self.proxies.values():proxy.close()
        self.proxies.clear()
