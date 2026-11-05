"""One Root-owned job anchor; only its shell drops to the executor UID+NNP.

The original Root parent supplies an anonymous socket and retained directory/
output FDs. No caller executable/path/environment is accepted. Cgroup empty
AND original wait/ECHILD are required; PID samples cannot fabricate cleanup.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import resource
import select
import signal
import socket
import stat
import struct
import subprocess
import time

from codex_bounded.trust import exists, process
from .contract import canonical, identifier, require
from .desk_anchor import Tree
from .identity import enforce_no_new_privs
from .workspace_cgroup import Root, Job, resources
from .workspace_custody import Installation, identity
from .workspace_environment import environment


def message(channel):
    def read(size):
        raw = bytearray()
        while len(raw) < size:
            part = channel.recv(size - len(raw)); require(part, 'managed_anchor_parent_eof'); raw.extend(part)
        return raw
    size = struct.unpack('!I', read(4))[0]
    require(0 < size <= 131072, 'managed_anchor_frame_bound')
    value = json.loads(read(size))
    required = {'owner_id', 'conversation_id', 'project_id', 'operation_id',
        'source', 'source_sha256', 'expires_at_ms', 'paths', 'identities'}
    require(type(value) is dict and required <= set(value) <= required|{'server_pid','server_start'}, 'managed_anchor_fields')
    return value


def send(channel, value):
    raw = canonical(value); channel.sendall(struct.pack('!I', len(raw)) + raw)


def main(package, arguments):
    require(os.geteuid() == 0 and package.identity_split and len(arguments) in (7,8), 'managed_anchor_root')
    endpoint, parent, start, workspace, cgroup, out, err = map(int, arguments[:7])
    core = socket.socket(fileno=int(arguments[7])) if len(arguments)==8 else None
    require(len({endpoint, workspace, cgroup, out, err}) == 5 and min(endpoint, workspace, cgroup, out, err) > 2,
            'managed_anchor_descriptors')
    original_parent = process(parent)
    require(parent == os.getppid() and original_parent and original_parent['uid'] == 0 and
            original_parent['start'] == start, 'managed_anchor_parent')
    with socket.socket(fileno=endpoint) as channel:
        peer, uid, _ = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(channel.family == socket.AF_UNIX and channel.type == socket.SOCK_STREAM and
                peer == parent and uid == 0, 'managed_anchor_peer')
        channel.settimeout(1); value = message(channel)
        if core is not None:
            server = process(value['server_pid'])
            peer_pid, peer_uid, _ = struct.unpack('3i',core.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            require(core.family==socket.AF_UNIX and core.type==socket.SOCK_STREAM and server and
                    peer_pid==server['pid'] and peer_uid==package.authority_uid==server['uid'] and
                    server['start']==value['server_start'], 'managed_anchor_core_source')
        require(value['owner_id'] == package.owner, 'managed_anchor_owner')
        for name in ('conversation_id', 'project_id', 'operation_id'): identifier(value[name])
        source = value['source']
        require(type(source) is str and 0 < len(source.encode()) <= 65536 and '\0' not in source and
                hashlib.sha256(source.encode()).hexdigest() == value['source_sha256'], 'managed_anchor_source')
        background = source.startswith('#!orkestr-job start\n')
        require(not source.startswith('#!orkestr-job ') or background, 'managed_anchor_operation')
        command = source[len('#!orkestr-job start\n'):] if background else source
        require(0 < len(command.encode()) <= 32768, 'managed_anchor_command_bound')
        profiles = ([package.beta['workspace_exec']] if 'workspace_exec' in package.beta else []) + package.beta.get('additional_workspace_exec', [])
        selected = [profile for profile in profiles if profile['conversation_id'] == value['conversation_id'] and
                    profile['project_id'] == value['project_id']]
        require(len(selected) == 1, 'managed_anchor_project')
        profile = selected[0]; trusted = profile['trusted']; limits = resources(trusted)
        installation = Installation(package, profile)
        root = None; job = None; tree = None; child = None; clean = False
        try:
            require(value['paths'] == [str(path) for path in installation.paths] and
                    value['identities'] == [list(v) for v in installation.identities] and
                    identity(workspace) == installation.identities[0], 'managed_anchor_project_changed')
            require(all(stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (out, err)), 'managed_anchor_output_type')
            execution_environment = environment(trusted['managed_executor'], installation.credential_protected, installation.workspace)
            from .resource_projects import git_environment
            execution_environment = git_environment(package,execution_environment)
            root = Root(profile['cgroup_root']); job = Job(root, 'job-' + value['operation_id'], cgroup); job.check()
            timeout = trusted.get('job_timeout_ms', 1800000) if background else trusted.get('command_timeout_ms', 30000)
            require(type(timeout) is int and 1 <= timeout <= (1800000 if background else 30000), 'managed_anchor_timeout')
            expires = value['expires_at_ms']; require(type(expires) is int, 'managed_anchor_launch_expired')
            remaining = expires - int(time.time() * 1000)
            require(0 < remaining <= 30000, 'managed_anchor_launch_expired')
            require(background or remaining>2000,'managed_anchor_result_margin')
            timeout = timeout if background else min(timeout, remaining-2000)
            deadline = time.monotonic() + timeout / 1000
            libc = ctypes.CDLL(None, use_errno=True)
            require(libc.prctl(36, 1, 0, 0, 0) == 0, 'managed_anchor_subreaper')
            tree = Tree(); cancelled = False; cancellation = None
            def cancel(reason):
                nonlocal cancelled, cancellation
                if not cancelled: cancellation = reason
                cancelled = True
            def stop(_signal, _frame):
                cancel('signal')
            signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
            require(libc.prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == parent,
                    'managed_anchor_parent_death')
            anchor_pid = os.getpid()
            common = {key:value[key] for key in ('operation_id','source_sha256')}
            if core is not None:
                # No business child exists at preparation. Only the exact
                # Core-created socket can activate while its Store fence holds.
                send(channel,{**common,'kind':'prepared'})
                activation = bytearray(); channel.setblocking(False)
                while bytes(activation)!=b'activate\n' and not cancelled:
                    if not exists(original_parent): cancel('parent_lost')
                    if not exists(server): cancel('core_lost')
                    if int(time.time()*1000)>=expires: cancel('deadline')
                    ready,_,_=select.select([core,channel],[],[],.05)
                    if channel in ready:
                        received=channel.recv(16);cancel('cancelled' if received else 'parent_closed')
                    if core in ready:
                        received=core.recv(10-len(activation))
                        if not received: cancel('core_closed')
                        else:
                            activation.extend(received)
                            if not b'activate\n'.startswith(bytes(activation)): cancel('cancelled')
                if cancelled:
                    require(job.empty(1),'managed_anchor_cleanup_unknown'); clean=True
                    send(channel,{**common,'kind':'complete','cleanup':True,'cancelled':True,
                        'cancellation':cancellation,'exit_code':None,'started':False})
                    return 0
                remaining=expires-int(time.time()*1000)
                require(remaining>0,'managed_anchor_launch_expired')
                if not background:
                    require(remaining>2000,'managed_anchor_result_margin')
                    timeout=min(timeout,remaining-2000)
                deadline=time.monotonic()+timeout/1000
            def dropped():
                # This anchor is single-threaded. Only this original shell
                # attaches to the fixed job while Root, before UID/cap drop.
                require(int(time.time() * 1000) < expires, 'managed_anchor_launch_expired')
                procs = os.open('cgroup.procs', os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=cgroup)
                try: require(os.write(procs, b'0') == 1, 'managed_anchor_attach')
                finally: os.close(procs)
                os.fchdir(workspace); os.close(workspace); os.close(cgroup); os.setsid()
                os.setgroups([]); os.setgid(package.executor_gid); os.setuid(package.executor_uid)
                enforce_no_new_privs()
                require(os.getresuid() == (package.executor_uid,) * 3 and os.getresgid() == (package.executor_gid,) * 3,
                        'managed_anchor_executor_identity')
                require(libc.prctl(1, signal.SIGKILL, 0, 0, 0) == 0 and os.getppid() == anchor_pid,
                        'managed_shell_parent_death')
                status = Path('/proc/self/status').read_text().splitlines()
                require(all(int(line.split()[1], 16) == 0 for line in status
                    if line.split(':', 1)[0] in ('CapInh', 'CapPrm', 'CapEff', 'CapAmb')),
                    'managed_shell_capabilities_retained')
                for kind, maximum in ((resource.RLIMIT_CORE, 0), (resource.RLIMIT_FSIZE, limits['file_bytes']),
                                      (resource.RLIMIT_NOFILE, limits['open_files']),
                                      (resource.RLIMIT_CPU, (timeout * limits['cpus'] + 999) // 1000 + 2)):
                    resource.setrlimit(kind, (maximum, maximum))
            child = subprocess.Popen(['/bin/sh', '-c', command], stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                cwd='/', env=execution_environment, close_fds=True, pass_fds=(workspace, cgroup), preexec_fn=dropped)
            execution_environment = None
            os.close(out); os.close(err)
            if core is not None: core.sendall(b'started\n');core.setblocking(False)
            send(channel, {**common, 'kind': 'ready'})
            channel.setblocking(False)
            original = process(child.pid)
            known = {(child.pid, original['start'])} if original else set()
            while child.poll() is None:
                if not exists(original_parent): cancel('parent_lost')
                if time.monotonic() >= deadline: cancel('deadline')
                try:
                    received = channel.recv(16)
                    cancel('cancelled' if received == b'cancel' else 'parent_closed' if not received else 'invalid_control')
                except BlockingIOError: pass
                if core is not None:
                    try:
                        received=core.recv(16)
                        cancel('cancelled' if received else 'core_closed')
                    except BlockingIOError: pass
                tree.capture(known); tree.observe()
                if cancelled: job.kill()
                time.sleep(.005)
            code = child.wait(); job.kill()
            until = time.monotonic() + 3
            while time.monotonic() < until:
                tree.drain(set(), seconds=.05)
                try: pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError: clean = True; break
                if pid == 0: time.sleep(.005)
            require(clean and job.empty(2) and all(p.gone() for p in tree.records.values()), 'managed_anchor_cleanup_unknown')
            channel.settimeout(1); send(channel, {**common, 'kind': 'complete', 'cleanup': True,
                                                'cancelled': cancelled, 'cancellation': cancellation, 'exit_code': code,'started':True})
            return 0
        finally:
            if job is not None:
                try: job.kill()
                except OSError: pass
            if child is not None and child.poll() is None: child.kill(); child.wait()
            if tree is not None:
                if not clean: tree.drain(set(), seconds=.25)
                tree.close()
            installation.close()
            if job is not None and job.fd is not None: os.close(job.fd)
            if root is not None: root.close()
            if core is not None: core.close()
