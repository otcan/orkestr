"""Root command claims and original-child lifecycle; no business completion.

Only the exact Core control peer reaches dispatch. Preparation is inert; the
anchor's private Core socket activates only within the WorkspaceExec fence.
Unknown delivery stays consumed in both
journals; receipt lookup never forks or manufactures a native/tool result.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import time

from codex_bounded.trust import exists, metadata, process, protected
from .contract import canonical, require
from .launch import atomic
from .workspace_cgroup import Root, resources
from .workspace_command import capability, sealed_source, parent as worker_parent
from .workspace_setup import Projects


class Operations:
    def __init__(self, manager):
        require(os.geteuid() == 0 and manager.package.identity_split, 'workspace_command_root')
        self.manager = manager; self.package = manager.package
        if manager.workspace_projects is None: manager.workspace_projects = Projects(self.package)
        self.projects = manager.workspace_projects
        self.directory = self.package.ledger_directory / 'workspace-commands'
        self.directory.mkdir(mode=0o700, exist_ok=True); protected(self.directory, True)
        require(self.directory.stat().st_mode & 0o777 == 0o700, 'workspace_command_journal_custody')
        self.roots = {}; self.active = {}; self.faulted = False
        self.identity = process(os.getpid())

    def receipt(self, path):
        row = metadata(path, 16384)
        return {key: row[key] for key in ('operation_id', 'source_sha256', 'kind', 'state', 'cleanup',
                                         'exit_code', 'cancelled', 'cancellation')}

    def descriptors(self, fds):
        require(len(fds) == 4 and len(set(fds)) == 4 and
                len({(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in fds}) == 4,
                'workspace_command_descriptors')
        source = self.manager.identity
        require(exists(source) and source['uid'] == self.package.authority_uid, 'workspace_command_server')
        for fd in fds[:3]: require(os.fstat(fd).st_uid == source['uid'], 'workspace_command_fd_source')
        for fd in fds[1:3]:
            require(stat.S_ISFIFO(os.fstat(fd).st_mode) and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_WRONLY,
                    'workspace_command_output_type')
        with socket.socket(fileno=os.dup(fds[3])) as channel:
            require(channel.family == socket.AF_UNIX and channel.type == socket.SOCK_STREAM, 'workspace_command_lifecycle_type')
            pid, uid, _ = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(pid == source['pid'] and uid == source['uid'] and exists(source), 'workspace_command_lifecycle_source')

    def start(self, request, fds):
        require(not self.faulted and self.manager.launcher is not None, 'workspace_command_custody')
        cap = capability(request['capability']); self.descriptors(fds)
        source, selected = sealed_source(fds[0], cap)
        # Background/control handling is enabled only with its separate durable
        # job lifecycle. Never reinterpret a reserved operation as a shell.
        require(selected.kind in ('command','start'), 'workspace_job_runtime_not_ready')
        worker = worker_parent(self.manager.launcher, request)
        scope = (request['conversation_id'], cap['project_id'])
        require(scope in self.projects.profiles and request['owner_id'] == self.package.owner, 'workspace_command_project_scope')
        remaining = cap['expires_at_ms'] - int(time.time() * 1000)
        require(0 < remaining <= 30000, 'workspace_command_deadline')
        profile = self.projects.profiles[scope]
        if selected.kind=='start':
            maximum=profile['trusted'].get('max_jobs',1)
            require(type(maximum) is int and 1<=maximum<=4,'workspace_job_disabled')
            require(sum(metadata(h['path'],16384)['kind']=='start' and
                metadata(h['path'],16384)['capability']['project_id']==cap['project_id']
                for h in self.active.values())<maximum,'workspace_job_capacity')
        if profile['cgroup_root'] not in self.roots: self.roots[profile['cgroup_root']] = Root(profile['cgroup_root'])
        # Root already retained these handles at Core's trusted project setup.
        require(scope in self.projects.installations, 'workspace_command_project_not_attested')
        installation = self.projects.installations[scope]; installation.check()
        frozen = {key: request[key] for key in ('owner_id', 'conversation_id', 'window_id', 'generation', 'capability')}
        fingerprint = hashlib.sha256(canonical(frozen)).hexdigest()
        path = self.directory / (cap['operation_id'] + '.json')
        if path.exists():
            require(metadata(path)['sha256'] == fingerprint, 'workspace_command_replay_conflict')
            return self.receipt(path)  # A known/unknown receipt never starts again.
        records = [metadata(p, 16384) for p in self.directory.glob('*.json')]
        require(sum(row['window_id'] == request['window_id'] for row in records) < 512 and
                len(self.active) < 4, 'workspace_command_capacity')
        row = {**frozen, 'operation_id': cap['operation_id'], 'source_sha256': cap['source_sha256'],
               'kind': selected.kind, 'sha256': fingerprint, 'state': 'claimed', 'cleanup': False,
               'exit_code': None, 'cancelled': False, 'cancellation': None}
        atomic(path, row)  # BEFORE cgroup creation/fork; a crash cannot reissue.
        job = child = channel = lifecycle = endpoint = None
        try:
            job = self.roots[profile['cgroup_root']].job(cap['operation_id'], resources(profile['trusted']))
            channel, endpoint = socket.socketpair()
            lifecycle = socket.socket(fileno=os.dup(fds[3])); lifecycle.setblocking(False)
            payload = {**{key: request[key] for key in ('owner_id', 'conversation_id')},
                'project_id': cap['project_id'], 'operation_id': cap['operation_id'], 'source': source,
                'source_sha256': cap['source_sha256'], 'expires_at_ms': cap['expires_at_ms'],
                'paths': [str(p) for p in installation.paths], 'identities': [list(v) for v in installation.identities]}
            payload.update(server_pid=self.manager.identity['pid'],server_start=self.manager.identity['start'])
            interpreter = str(Path('/usr/bin/python3').resolve())
            inherited = (endpoint.fileno(), installation.fds[0], job.fd, fds[1], fds[2], lifecycle.fileno())
            child = subprocess.Popen([interpreter, '-I', '-S', '-B', str(self.package.root/'codex_service/entry.py'),
                'workspace-anchor', *map(str, (endpoint.fileno(), os.getpid(), self.identity['start'],
                    installation.fds[0], job.fd, fds[1], fds[2], lifecycle.fileno()))], pass_fds=inherited,
                cwd='/', env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            handle = dict(child=child, identity=process(child.pid), job=job, channel=channel,
                path=path, worker=dict(worker.broker), window=request['window_id'], generation=request['generation'],
                buffer=b'', prepared=False, ready=False, proof=None, cancelled=False, uncertain=False,
                kind=selected.kind,job_timeout=profile['trusted'].get('job_timeout_ms',1800000),
                deadline=time.monotonic()+remaining/1000)
            self.active[cap['operation_id']] = handle
            lifecycle.close();lifecycle=None  # Only the anchor retains Core's activation endpoint.
            endpoint.close(); endpoint = None
            raw = canonical(payload); channel.settimeout(.2)
            channel.sendall(struct.pack('!I',len(raw))+raw); channel.setblocking(False)
            # Preparation starts no business child. Core must activate the
            # anchor separately while holding its consumed launch fence.
            until = min(time.monotonic()+.8, handle['deadline'])
            while not handle['prepared'] and time.monotonic() < until:
                self.poll_handle(handle)
                require(child.poll() is None or handle['prepared'], 'workspace_command_anchor_lost')
                time.sleep(.002)
            require(handle['prepared'], 'workspace_command_prepare_unknown')
            row['state'] = 'prepared'; row['anchor'] = handle['identity']; atomic(path,row)
            return self.receipt(path)
        except BaseException:
            row['state'] = 'unknown'; atomic(path,row)
            if cap['operation_id'] in self.active:
                self.active[cap['operation_id']]['uncertain'] = True
                self.cancel(cap['operation_id'])
            else:
                if child is not None: child.kill(); child.wait(timeout=2)
                if channel is not None: channel.close()
                if lifecycle is not None: lifecycle.close()
                if job is not None:
                    job.kill()
                    if job.empty(2): job.close_empty()
            raise
        finally:
            if endpoint is not None: endpoint.close()

    def poll_handle(self, handle):
        try: raw = handle['channel'].recv(8193)
        except BlockingIOError: raw = None
        except OSError: raw = b''
        if raw:
            handle['buffer'] += raw
            require(len(handle['buffer']) <= 8192, 'workspace_anchor_proof_bound')
            while len(handle['buffer']) >= 4:
                size = struct.unpack('!I', handle['buffer'][:4])[0]
                require(0 < size <= 4096, 'workspace_anchor_proof_bound')
                if len(handle['buffer']) < size+4: break
                frame = json.loads(handle['buffer'][4:size+4]); handle['buffer'] = handle['buffer'][size+4:]
                row = metadata(handle['path'], 16384)
                require(frame.get('operation_id') == row['operation_id'] and frame.get('source_sha256') == row['source_sha256'],
                        'workspace_anchor_proof_scope')
                common = {'operation_id','source_sha256','kind'}
                if frame.get('kind') == 'prepared':
                    require(set(frame)==common and not handle['prepared'] and not handle['ready'],'workspace_anchor_prepared')
                    handle['prepared']=True
                elif frame.get('kind') == 'ready':
                    require(set(frame) == common and handle['prepared'] and not handle['ready'], 'workspace_anchor_ready')
                    handle['ready'] = True
                    if handle['kind']=='start':handle['deadline']=time.monotonic()+handle['job_timeout']/1000
                    row['state']='running';atomic(handle['path'],row)
                else:
                    require(set(frame) == common | {'cleanup','cancelled','cancellation','exit_code','started'} and
                        frame['kind'] == 'complete' and frame['cleanup'] is True and type(frame['cancelled']) is bool and
                        type(frame['started']) is bool and frame['started']==handle['ready'] and
                        (type(frame['exit_code']) is int if frame['started'] else frame['exit_code'] is None) and
                        handle['prepared'] and handle['proof'] is None and frame['cancellation'] in
                        (None,'signal','parent_lost','deadline','cancelled','parent_closed','invalid_control','core_lost','core_closed'),
                        'workspace_anchor_completion')
                    handle['proof'] = frame

    def cancel(self, operation):
        handle = self.active.get(operation)
        if handle and not handle['cancelled']:
            handle['cancelled'] = True
            try: handle['channel'].send(b'cancel')
            except OSError: pass
            handle['job'].kill()

    def cancel_window(self, window):
        for operation, handle in self.active.items():
            if handle['window'] == window: self.cancel(operation)

    def tick(self, window_active):
        for operation, handle in list(self.active.items()):
            if (time.monotonic() >= handle['deadline'] or handle['kind']=='command' and not exists(handle['worker']) or
                not exists(self.manager.identity) or not window_active(handle['window'],handle['generation'])):
                self.cancel(operation)
            try: self.poll_handle(handle)
            except Exception:
                handle['uncertain'] = True; self.cancel(operation)
            if handle['child'].poll() is None: continue
            row = metadata(handle['path'],16384); proof = handle['proof']
            if proof and handle['child'].returncode == 0 and not handle['buffer'] and handle['job'].empty(.1):
                row.update(cleanup=True, exit_code=proof['exit_code'], cancelled=proof['cancelled'],
                           cancel_requested=handle['cancelled'], cancellation=proof['cancellation'])
                row['state'] = 'unknown' if handle['uncertain'] else 'cancelled' if row['cancelled'] else 'complete' if row['exit_code']==0 else 'failed'
            else:
                row['state'] = 'unknown'; row['cleanup'] = False
                handle['job'].kill()
            atomic(handle['path'],row)
            # Only the original Child wait + ECHILD proof + empty group permit
            # releasing this Root-owned target. Unknown cleanup stays retained.
            if not row['cleanup']: continue
            handle['job'].close_empty(); handle['channel'].close()
            del self.active[operation]

    def fault(self):
        self.faulted = True
        for operation, handle in self.active.items():
            handle['uncertain'] = True; self.cancel(operation)
            row = metadata(handle['path'],16384); row['state']='unknown'; atomic(handle['path'],row)

    def window_clean(self, window):
        return all(row['cleanup'] is True and row['state'] != 'unknown' for path in self.directory.glob('*.json')
                   if (row:=metadata(path,16384))['window_id']==window)

    def close(self):
        for operation in self.active: self.cancel(operation)
        until = time.monotonic()+4
        while self.active and time.monotonic()<until: self.tick(lambda *_:False); time.sleep(.005)
        clean = not self.active and all((row:=metadata(path,16384))['cleanup'] is True and row['state']!='unknown'
            for path in self.directory.glob('*.json'))
        if clean:
            for root in self.roots.values(): root.close()
        return clean


def dispatch(manager, request, window, descriptors):
    require(manager.package.identity_split, 'workspace_command_window')
    if getattr(manager, 'workspace_commands', None) is None: manager.workspace_commands = Operations(manager)
    commands = manager.workspace_commands
    if request['operation'] == 'workspace_command':
        manager._package_preflight()
        require(window is not None, 'workspace_command_window')
        require(manager._desk_window_active(window.window, window.generation), 'workspace_command_window')
        receipt = commands.start(request, descriptors)
    else:
        path = commands.directory / (request['operation_id'] + '.json'); row = metadata(path,16384)
        require(row['owner_id'] == request['owner_id'] and row['conversation_id'] == request['conversation_id'] and
                row['window_id'] == request['window_id'] and row['generation'] == request['generation'] and
                row['source_sha256'] == request['source_sha256'], 'workspace_command_receipt_scope')
        if request['operation'] == 'workspace_command_cancel': commands.cancel(request['operation_id'])
        commands.tick(manager._desk_window_active); receipt = commands.receipt(path)
    return {'ok': True, 'receipt': manager.ledger.status(request['conversation_id']), 'command': receipt}
