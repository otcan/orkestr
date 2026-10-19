"""Actual public package, ordinary HTTP and namespace path; synthetic native only."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import urllib.error

from owned_fast_case import FastCase
from owned_execution_http import binary, wait_for
from owned_native_probe import OwnedNativeProbe, descendants, process_start

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'v2/provider-broker'))
from codex_bounded.controller import Runtime
from codex_bounded.trust import exists, process

SPEC = importlib.util.spec_from_file_location('selected_roles_packager', ROOT / 'v2/packaging/selected_codex_roles.py')
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)
UID = GID = 65534


class SelectedNativeProbe(OwnedNativeProbe):
    def __init__(self, executable):
        # The fixed supervisor execve uses argv[0]="native". Bind that locator
        # to the actual immutable ELF inode before crediting the host identity.
        super().__init__('native')
        self.executable = executable
        self.validated = set()

    def observe(self, server_pid, rows):
        result = super().observe(server_pid, rows)
        for row in result:
            identity = (row['pid'], row['process_start'])
            if identity not in self.validated:
                actual = (Path('/proc') / str(row['pid']) / 'exe').stat()
                expected = self.executable.stat()
                assert (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), 'native executable alias'
                self.validated.add(identity)
        return result


class SelectedRolesCase(FastCase):
    def __init__(self, source):
        assert os.geteuid() == 0, 'explicit root synthetic package test required'
        self.root = Path(tempfile.mkdtemp(prefix='selected-roles-http-', dir='/opt'))
        self.root.chmod(0o755)
        self.source = source
        self.state = self.directory('state')
        self.home = self.directory('state/data')
        self.directory('state/provider-home')
        self.workspaces = [self.directory('workspace-' + role) for role in ('deep', 'fast')]
        self.accounts = [self.directory('account-' + role) for role in ('deep', 'fast')]
        self.workspace = self.workspaces[0]
        self.auth = self.directory('synthetic-account') / 'auth.json'
        self.private(self.auth, b'{"fixture":"synthetic-roles-only"}\n')
        self.bootstrap = 'synthetic-bootstrap-token-selected-role-http-only'
        self.private(self.state / 'bootstrap.token', self.bootstrap.encode())
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.origin = f'http://127.0.0.1:{self.port}'
        self.process = self.runtime = None
        self.cookie = self.csrf = None
        self.probes = [SelectedNativeProbe(self.root / 'package/native') for _ in range(2)]
        self.known = {}
        self.receipt = None

    def directory(self, name):
        path = self.root / name
        path.mkdir(mode=0o700)
        os.chown(path, UID, GID)
        return path

    @staticmethod
    def private(path, content):
        path.write_bytes(content)
        os.chown(path, UID, GID)
        path.chmod(0o600)

    def observe(self):
        if self.process is not None and self.process.poll() is None:
            for pid in {self.process.pid, *descendants(self.process.pid)}:
                item = process(pid)
                if item:
                    self.known[(pid, item['start'])] = item

    def owned_listener(self):
        assert self.process.poll() is None, 'ordinary owned child exited before listener'
        self.observe()
        root = Path('/proc') / str(self.process.pid)
        sockets = set()
        for fd in (root / 'fd').iterdir():
            try:
                target = os.readlink(fd)
            except FileNotFoundError:
                continue
            if target.startswith('socket:['):
                sockets.add(target[8:-1])
        for line in (root / 'net/tcp').read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == f'0100007F:{self.port:04X}' and fields[3] == '0A' and fields[9] in sockets:
                return True
        return False

    def start(self, configured=False, **_unused):
        if configured:
            if self.runtime is None:
                self.runtime = Runtime(self.receipt['package'], self.receipt['manifest_sha256'])
            self.runtime.start()
            self.process = self.runtime.child
        else:
            env = {'PATH':'/usr/bin:/bin', 'LANG':'C.UTF-8', 'HOME':str(self.state / 'provider-home'),
                   'ORKESTR_V2_HOME':str(self.home), 'ORKESTR_V2_BIND':f'127.0.0.1:{self.port}',
                   'ORKESTR_V2_BOOTSTRAP_TOKEN':self.bootstrap}
            self.process = subprocess.Popen([str(binary)], env=env, user=UID, group=GID, extra_groups=[],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(self.owned_listener, 'exact owned ordinary listener')
        def healthy():
            assert self.process.poll() is None, 'ordinary owned child exited during health'
            try:
                return self.request('/api/v2/health', browser=False)[0] == 200
            except (urllib.error.URLError, TimeoutError):
                return False
        wait_for(healthy, 'ordinary health')

    def stop(self):
        if self.process is None:
            return
        current = self.process
        try:
            try:
                self.trace()
            finally:
                if self.runtime is not None and self.runtime.child is current:
                    self.runtime.stop_server()
                elif current.poll() is None:
                    current.send_signal(signal.SIGINT)
                    try:
                        current.wait(timeout=6)
                    except subprocess.TimeoutExpired:
                        current.kill();current.wait(timeout=3)
                        raise AssertionError('synthetic bootstrap required forced cleanup')
            assert current.returncode == 0, 'ordinary shutdown did not complete cleanly'
        finally:
            self.process = None

    def configure(self):
        assert self.receipt is None, 'one fixed package per case'
        native = self.root / 'synthetic-native'
        subprocess.run(['cc','-std=c11','-O2','-Wall','-Wextra','-Werror',
                        str(ROOT / 'v2/tests/selected_codex_roles_native.c'),'-o',str(native)],
                       env={'PATH':'/usr/bin:/bin'}, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        native.chmod(0o555)
        self.private(self.state / 'machine.token', self.machine.encode())
        for index, role in enumerate(('deep','fast')):
            self.private(self.workspaces[index] / 'role', role.encode())
            self.private(self.workspaces[index] / 'mode', b'complete')
        plan = {'format':'orkestr-v2-codex-bounded-roles-plan-v1', 'output':str(self.root / 'package'),
                'source_repository':str(ROOT), 'source_commit':self.source, 'server':str(binary), 'native':str(native),
                'uid':UID, 'gid':GID, 'home':str(self.state), 'auth_file':str(self.auth),
                'egress_directory':str(self.root / 'endpoint'), 'bootstrap_file':str(self.state / 'bootstrap.token'),
                'machine_token_file':str(self.state / 'machine.token'), 'conversation_id':self.conversation,
                'port':self.port, 'lifetime_seconds':120,
                'roles':{role:{'workspace':str(self.workspaces[index]), 'state_root':str(self.accounts[index]),
                               'namespace':'selected-' + role, 'supervisor_key':'selected-owner-' + role}
                         for index,role in enumerate(('deep','fast'))}}
        self.receipt = packager.prepare(plan)

    def trace_for(self, index):
        self.observe()
        path = self.accounts[index] / 'sessions/synthetic-role.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return self.probes[index].observe(self.process.pid if self.process else None, rows)

    def cleanup(self):
        errors = []
        for name, operation in [('server',self.stop), ('window',lambda:self.runtime.close() if self.runtime else None)]:
            try:
                operation()
            except BaseException as error:
                errors.append((name,type(error).__name__))
        wait_for(lambda: all(not exists(item) for item in self.known.values()), 'all retained process identities gone')
        assert all(probe.gone() for probe in self.probes), 'native tree remains'
        assert not (self.root / 'endpoint/egress.sock').exists(), 'egress endpoint remains'
        with socket.socket() as sock:
            sock.settimeout(.2)
            assert sock.connect_ex(('127.0.0.1',self.port)) != 0, 'ordinary listener remains'
        if self.runtime:
            assert not self.runtime.forced and not self.runtime.poisoned, 'uncertain window cleanup'
        assert not errors, errors
