"""Opt-in root-only recovery rehearsal against a disposable actual server.

Uses synthetic stopped-unit metadata, not systemd or a live service. The real
authority process, parent socket, inherited lock and Core transaction run.
No live account, credential, deployment or service configuration is changed.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'v2/provider-broker'))
from codex_service.password_recovery import recover

UID, GID = 62011, 62013
USERNAME = 'synthetic-recovery-owner'
OLD, NEW = 'synthetic-old-recovery-password', 'synthetic-new-recovery-password'
CONFIG = {'unit': 'synthetic-recovery.service',
          'cgroup': '/system.slice/synthetic-recovery.service'}


def stopped_runner(*_args, **_kwargs):
    return subprocess.CompletedProcess([], 0,
        'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=\n', '')


class Rehearsal:
    def __init__(self, binary, commit):
        assert os.geteuid() == 0, 'explicit root fixture required'
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                occupied = process.stat().st_uid == UID
            except FileNotFoundError:
                continue
            assert not occupied, 'fixture UID already active'
        self.directory = Path(tempfile.mkdtemp(prefix='orkestr-recovery-', dir='/'))
        self.directory.chmod(0o755)
        self.home = self.directory / 'data'
        self.home.mkdir(mode=0o700)
        os.chown(self.home, UID, GID)
        self.package_root = self.directory / 'package'
        self.package_root.mkdir(mode=0o755)
        self.binary = self.package_root / 'server'
        shutil.copyfile(binary, self.binary)
        self.binary.chmod(0o555)
        identity = json.loads(subprocess.check_output([self.binary, '--version', '--json']))
        assert identity['source_commit'] == commit
        self.report = {'scope': __doc__.strip(), 'source_commit': commit,
                       'server_sha256': hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                       'authority_uid': UID, 'group': GID, 'simulated_systemd_metadata': True}
        self.ledger = self.directory / 'ledger'
        self.ledger.mkdir(mode=0o700)
        (self.ledger / 'manager.lock').touch(mode=0o600)
        self.cgroups = self.directory / 'cgroups'
        self.cgroups.mkdir()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]
        self.origin = f'http://127.0.0.1:{self.port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.process = None
        self.log_path = self.directory / 'server.log'

    def request(self, path, method='GET', body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.origin + path, method=method, data=data,
            headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.code, json.loads(raw) if raw else None, response.headers

    def start(self):
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'PYTHONDONTWRITEBYTECODE': '1', 'ORKESTR_V2_HOME': str(self.home),
            'ORKESTR_V2_BIND': f'127.0.0.1:{self.port}', 'ORKESTR_V2_ORIGIN': self.origin,
            'ORKESTR_V2_BOOTSTRAP_TOKEN': 'synthetic-recovery-bootstrap-token-long-enough'}
        with self.log_path.open('ab') as log:
            self.process = subprocess.Popen([self.binary], cwd='/', env=environment,
                user=UID, group=GID, extra_groups=[], umask=0o077,
                stdout=log, stderr=log)
        for _ in range(150):
            assert self.process.poll() is None, self.log_path.read_text()[-2048:]
            try:
                if self.request('/api/v2/health')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise AssertionError('fixture startup deadline')

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            assert self.process.wait(timeout=10) == 0

    def snapshot(self):
        with sqlite3.connect(f'file:{self.home}/core.sqlite3?mode=ro', uri=True) as connection:
            connection.execute('PRAGMA query_only=ON')
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")]
            # Compare all durable contents; only the two credential tables may change.
            return {table: connection.execute('SELECT * FROM "' + table + '" ORDER BY rowid').fetchall()
                    for table in tables}

    def package(self):
        return SimpleNamespace(root=self.package_root, data=self.home,
            authority_uid=UID, authority_gid=GID, ledger_directory=self.ledger,
            owner=self.owner, runtime={'password_rotation_ready': True,
                                      'operator_recovery': CONFIG})

    def run(self):
        self.start()
        credentials = {'username': USERNAME, 'password': OLD}
        assert self.request('/api/v2/setup', 'POST', credentials,
            {'X-Orkestr-Bootstrap': 'synthetic-recovery-bootstrap-token-long-enough'})[0] == 201
        code, browser, headers = self.request('/api/v2/browser/session', 'POST', credentials,
                                              {'Origin': self.origin})
        assert code == 200
        self.owner = browser['owner_id']
        browser_headers = {'Cookie': headers['Set-Cookie'].split(';')[0],
                           'Origin': self.origin, 'X-Orkestr-CSRF': browser['csrf_token']}
        code, machine, _ = self.request('/api/v2/machine/session', 'POST', credentials)
        assert code == 200
        machine_headers = {'Authorization': 'Bearer ' + machine['token']}
        code, service, _ = self.request('/api/v2/browser/service-credentials', 'POST',
            {'username': USERNAME, 'current_password': OLD, 'label': 'synthetic recovery canary'},
            browser_headers)
        assert code == 200
        code, _session, headers = self.request('/api/v2/machine/service-session', 'POST',
                                               {'service_token': service['service_token']})
        assert code == 200
        service_headers = {'Cookie': headers['Set-Cookie'].split(';')[0]}
        self.stop()
        before = self.snapshot()
        package = self.package()
        # Refusals happen before credential changes, and retain the exact lock inode.
        lock_path = self.ledger / 'manager.lock'
        lock_identity = lock_path.stat().st_ino
        lock = os.open(lock_path, os.O_RDWR)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                recover(package, USERNAME, NEW, runner=stopped_runner, cgroup_root=self.cgroups)
            except BlockingIOError:
                pass
            else:
                raise AssertionError('active manager lock accepted')
        finally:
            os.close(lock)
        assert self.snapshot() == before
        package.owner = '11111111-1111-4111-8111-111111111111'
        refused = recover(package, USERNAME, NEW, runner=stopped_runner, cgroup_root=self.cgroups)
        assert refused == {'status': 'refused', 'code': 'recovery_owner_mismatch'}, refused
        assert self.snapshot() == before
        # An actual non-root parent creates its own socket; it cannot impersonate Root.
        nonroot = subprocess.run(['/usr/bin/python3', '-I', '-S', '-B', '-c',
            "import socket,subprocess,sys\np,c=socket.socketpair()\n"
            "child=subprocess.Popen([sys.argv[1],'--recover-owner-password'],stdin=c,"
            "stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)\nc.close()\n"
            "out,_=child.communicate(timeout=10)\nassert child.returncode!=0\n"
            "sys.stdout.buffer.write(out)\n", str(self.binary)],
            user=UID, group=GID, extra_groups=[], cwd='/',
            env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'},
            capture_output=True, timeout=15, check=True)
        assert json.loads(nonroot.stdout)['code'] == 'recovery_root_parent'
        assert self.snapshot() == before
        package.owner = self.owner
        result = recover(package, USERNAME, NEW, runner=stopped_runner, cgroup_root=self.cgroups)
        assert result['status'] == 'changed', result
        after = self.snapshot()
        assert before.keys() == after.keys()
        assert {key for key in before if before[key] != after[key]} == {'owners', 'auth_sessions'}
        assert lock_path.stat().st_ino == lock_identity
        self.report.update(negative_lock=True, negative_owner=True, negative_nonroot_peer=True,
                           only_password_and_browser_sessions_changed=True, recovery=result)
        self.start()
        assert self.request('/api/v2/browser/session', headers=browser_headers)[0] == 401
        assert self.request('/api/v2/browser/session', 'POST', credentials,
                            {'Origin': self.origin})[0] == 401
        assert self.request('/api/v2/browser/session', 'POST',
            {'username': USERNAME, 'password': NEW}, {'Origin': self.origin})[0] == 200
        assert self.request('/api/v2/projects', headers=machine_headers)[0] == 200
        assert self.request('/api/v2/browser/session', headers=service_headers)[0] == 200
        assert self.request('/api/v2/machine/service-session', 'POST',
                            {'service_token': service['service_token']})[0] == 200
        self.report.update(pass_result=True, old_browser_revoked=True, old_password_rejected=True,
            new_password_accepted=True, machine_bearer_preserved=True,
            service_cookie_preserved=True, service_key_preserved=True)
        return self.report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--report', type=Path, required=True)
    arguments = parser.parse_args()
    fixture = Rehearsal(arguments.server.resolve(strict=True), arguments.source_commit)
    try:
        report = fixture.run()
    finally:
        fixture.stop()
        shutil.rmtree(fixture.directory)
    report['scratch_cleaned'] = True
    arguments.report.write_text(json.dumps(report, indent=2) + '\n')
    arguments.report.chmod(0o600)
    print(json.dumps({'pass': True, 'scratch_cleaned': True,
                      'source_commit': arguments.source_commit}))


if __name__ == '__main__':
    main()
