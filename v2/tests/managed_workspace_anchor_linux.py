"""Opt-in kernel component oracle, only inside a disposable delegated scope.

Run as Root with systemd-run --scope --unit=orkestr-workspace-fixture-<uuid>
-p Delegate=yes -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=128. This is
not Core HTTP/provider/claim-journal qualification or production activation.
"""
import argparse
import array
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time
from types import SimpleNamespace
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'v2/provider-broker'))
from codex_bounded.trust import process
from codex_service_fixture import ServiceFixture, UID, GID
from codex_service.workspace_cgroup import Root, resources
from codex_service.workspace_custody import Installation


def scope():
    assert os.geteuid() == 0
    entries = Path('/proc/self/cgroup').read_text().splitlines()
    assert len(entries) == 1 and entries[0].startswith('0::/')
    relative = entries[0][3:]
    base = Path('/sys/fs/cgroup') / relative.lstrip('/')
    assert base.name.startswith('orkestr-workspace-fixture-') and base.name.endswith('.scope')
    uuid.UUID(base.name.removeprefix('orkestr-workspace-fixture-').removesuffix('.scope'))
    assert (base / 'cgroup.procs').read_text().split() == [str(os.getpid())]
    manager = base / 'manager'; manager.mkdir()
    (manager / 'cgroup.procs').write_text(str(os.getpid()))
    (base / 'cgroup.subtree_control').write_text('+cpu +memory +pids')
    jobs = base / 'jobs'; jobs.mkdir(mode=0o700); jobs.chmod(0o700)
    (jobs / 'cgroup.subtree_control').write_text('+cpu +memory +pids')
    return base, jobs


def read(channel):
    def exact(size):
        result = bytearray()
        while len(result) < size:
            part = channel.recv(size - len(result)); assert part; result.extend(part)
        return result
    size = struct.unpack('!I', exact(4))[0]; assert 0 < size <= 4096
    return json.loads(exact(size))


def prepare(fixture, jobs):
    project = fixture.directory('private-project')
    git = project / '.git'; git.mkdir(mode=0o700); os.chown(git, UID, GID)
    home = fixture.root / 'core-private'; home.mkdir(mode=0o700); os.chown(home, UID - 1, GID)
    core = home / 'core.sqlite3'; core.write_text('synthetic Core-private marker')
    core.chmod(0o600); os.chown(core, UID - 1, GID)
    secret = fixture.root / 'business.env'; secret.write_text('BUSINESS_ACCOUNT_KEY=synthetic-selected\nOTHER_ACCOUNT_TOKEN=synthetic-excluded\n')
    secret.chmod(0o600)
    trusted = {'managed_executor': {'environment': {'HOME': str(fixture.home), 'PATH': '/usr/bin:/bin'},
        'credentials': [{'path': str(secret), 'keys': ['BUSINESS_ACCOUNT_KEY']}]},
        'memory_bytes': 256 * 1024**2, 'pids': 16, 'cpus': 1, 'file_bytes': 1024**2,
        'open_files': 256, 'command_timeout_ms': 1000}
    profile = dict(conversation_id=str(uuid.uuid4()), project_id=str(uuid.uuid4()), workspace=str(project),
        allowed_roots=[str(project)], protected_roots=[str(home)], cgroup_root=str(jobs),
        toolchain_root=str(fixture.root / 'unused-legacy-image'), trusted=trusted)
    package = dict(identity_split=True, executor_uid=UID, executor_gid=GID, authority_uid=UID-1, owner=str(uuid.uuid4()),
        home=str(home), ledger_directory=str(fixture.ledger_directory), provider_home=str(fixture.home / 'provider-home'),
        root=str(fixture.package), beta={'workspace_exec': profile})
    return package, profile, core, project


def run_case(fixture, package, profile, project, core, root, kind):
    # All helpers/keys/data are synthetic and source hashes are captured below.
    value = dict(package)
    value.update({k: Path(value[k]) for k in ('home', 'ledger_directory', 'provider_home', 'root')})
    selected = SimpleNamespace(**value)
    installation = Installation(selected, profile)
    operation = str(uuid.uuid4()); job = root.job(operation, resources(profile['trusted']))
    config = fixture.root / ('anchor-' + kind + '.json')
    config.write_text(json.dumps(package)); config.chmod(0o600)
    bootstrap = fixture.root / 'run-anchor.py'
    bootstrap.write_text('import json,sys\nfrom pathlib import Path\nfrom types import SimpleNamespace\n'
        'sys.path.insert(0,' + repr(str(ROOT / 'v2/provider-broker')) + ')\n'
        'from codex_service.workspace_anchor import main\n'
        'value=json.loads(Path(sys.argv[1]).read_text())\n'
        'for key in ("home","ledger_directory","provider_home","root"):value[key]=Path(value[key])\n'
        'raise SystemExit(main(SimpleNamespace(**value),sys.argv[2:]))\n')
    bootstrap.chmod(0o500)
    probe = project / ('probe-' + kind + '.py')
    probe.write_text('import ctypes,json,os\nfrom pathlib import Path\n'
        'assert os.geteuid()==' + str(UID) + '\n'
        'assert os.getgroups()==[]\n'
        'assert ctypes.CDLL(None).prctl(39,0,0,0,0)==1\n'
        'assert all(int(line.split()[1],16)==0 for line in Path("/proc/self/status").read_text().splitlines() if line.split(":",1)[0] in ("CapInh","CapPrm","CapEff","CapAmb"))\n'
        'try:Path(' + repr(str(core)) + ').read_bytes()\n'
        'except PermissionError:pass\nelse:raise AssertionError("Core readable")\n'
        'assert os.environ.get("BUSINESS_ACCOUNT_KEY")=="synthetic-selected"\n'
        'assert "OTHER_ACCOUNT_TOKEN" not in os.environ\n'
        'assert os.getcwd()==' + repr(str(project)) + '\n'
        'Path("proof-' + kind + '").write_text("executor project write")\n'
        'print(json.dumps({"uid":os.geteuid(),"nnp":True,"core_denied":True,"selected_key_only":True}),flush=True)\n' +
        ('import time\ntime.sleep(10)\n' if kind in ('timeout', 'cancel', 'cancel_after_exit') else
         'import time\nmarker=Path("detached-ready")\nif os.fork()==0:\n os.setsid()\n if os.fork()==0:\n  marker.write_text(str(os.getpid()))\n  time.sleep(10)\n os._exit(0)\n'
         'until=time.monotonic()+.5\nwhile not marker.exists():\n assert time.monotonic()<until\n time.sleep(.005)\n'))
    probe.chmod(0o600); os.chown(probe, UID, GID)
    command = '/usr/bin/python3 -I -S -B ' + str(probe)
    source_sha = hashlib.sha256(command.encode()).hexdigest()
    payload = dict(owner_id=package['owner'], conversation_id=profile['conversation_id'], project_id=profile['project_id'],
        operation_id=operation, source=command, source_sha256=source_sha, expires_at_ms=int(time.time()*1000)+25000,
        paths=[str(p) for p in installation.paths], identities=[list(v) for v in installation.identities])
    parent, endpoint = socket.socketpair(); stdout, out = os.pipe2(os.O_CLOEXEC); stderr, err = os.pipe2(os.O_CLOEXEC)
    control = fake = source_fd = None
    if kind in ('activate','no_activation'):
        control, peer = socket.socketpair()
        program='''import array,os,socket,sys
c=socket.socket(fileno=int(sys.argv[1]));own,other=socket.socketpair()
c.sendmsg([b'E'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[other.fileno()]))]);other.close()
command=c.recv(32)
if command==b'activate':
 own.sendall(b'activate\\n');answer=bytearray()
 while len(answer)<8:
  part=own.recv(8-len(answer))
  if not part:raise SystemExit(5)
  answer.extend(part)
 c.sendall(answer);c.recv(32)
elif command==b'drop':own.close();c.sendall(b'dropped')
else:raise SystemExit(6)
'''
        fake=subprocess.Popen([sys.executable,'-I','-S','-B','-c',program,str(peer.fileno())],
            pass_fds=(peer.fileno(),),user=UID-1,group=GID,extra_groups=[],env={'PATH':'/usr/bin:/bin'},
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        peer.close();control.settimeout(3)
        _,ancillary,flags,_=control.recvmsg(1,socket.CMSG_SPACE(4),socket.MSG_CMSG_CLOEXEC)
        assert not flags&(socket.MSG_CTRUNC|socket.MSG_TRUNC) and len(ancillary)==1
        level,message,raw=ancillary[0];assert(level,message)==(socket.SOL_SOCKET,socket.SCM_RIGHTS)
        received=array.array('i');received.frombytes(raw);assert len(received)==1;source_fd=received[0]
        payload.update(server_pid=fake.pid,server_start=process(fake.pid)['start'])
    child = None
    try:
        identity = process(os.getpid())
        child = subprocess.Popen([sys.executable, '-I', '-S', '-B', str(bootstrap), str(config),
            *map(str, (endpoint.fileno(), os.getpid(), identity['start'], installation.fds[0], job.fd, out, err)),
            *([str(source_fd)] if source_fd is not None else [])],
            pass_fds=(endpoint.fileno(), installation.fds[0], job.fd, out, err,*([source_fd] if source_fd is not None else [])), env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        endpoint.close(); os.close(out); os.close(err); out = err = None
        if source_fd is not None:os.close(source_fd);source_fd=None
        raw = json.dumps(payload).encode(); parent.sendall(struct.pack('!I',len(raw))+raw); parent.settimeout(5)
        ready = read(parent)
        if fake is not None:
            assert ready=={'operation_id':operation,'source_sha256':source_sha,'kind':'prepared'}
            time.sleep(.1);assert not (project/('proof-'+kind)).exists() and not job.populated()
            control.sendall(b'activate' if kind=='activate' else b'drop')
            assert control.recv(32)==(b'started\n' if kind=='activate' else b'dropped')
            if kind=='activate':ready=read(parent)
        if kind!='no_activation':assert ready == {'operation_id':operation, 'source_sha256':source_sha, 'kind':'ready'}
        if kind in ('cancel', 'cancel_after_exit'):
            until = time.monotonic() + .8
            while not (project / ('proof-' + kind)).exists():
                assert time.monotonic() < until
                time.sleep(.005)
            if kind == 'cancel_after_exit':
                # Stop only the Root anchor, outside the job cgroup. Force
                # cancellation and job exit before its next child poll.
                child.send_signal(signal.SIGSTOP)
                until = time.monotonic() + 1
                while '\nState:\tT' not in Path('/proc', str(child.pid), 'status').read_text():
                    assert time.monotonic() < until
                    time.sleep(.005)
            parent.sendall(b'cancel')
            if kind == 'cancel_after_exit':
                job.kill(); assert job.empty(2)
                child.send_signal(signal.SIGCONT)
        complete = read(parent)
        assert complete['operation_id'] == operation and complete['source_sha256'] == source_sha
        assert complete['kind'] == 'complete' and complete['cleanup'] is True
        assert complete['cancelled'] == (kind in ('timeout','cancel','cancel_after_exit','no_activation'))
        assert complete['cancellation'] == ('deadline' if kind == 'timeout' else 'cancelled' if kind in ('cancel','cancel_after_exit') else 'core_closed' if kind=='no_activation' else None)
        assert child.wait(timeout=3) == 0, child.stderr.read().decode()
        output = os.read(stdout, 4096); error_output = os.read(stderr, 4096)
        assert not error_output and not job.populated()
        if kind=='no_activation':assert not output and complete['started'] is False and not (project/('proof-'+kind)).exists()
        else:
            proof = json.loads(output); assert proof['uid'] == UID and proof['nnp'] and proof['core_denied'] and proof['selected_key_only']
            assert (project / ('proof-' + kind)).stat().st_uid == UID
        if kind == 'normal': assert (project / 'detached-ready').exists()
        job.close_empty()
        return dict(kind=kind, original_root_anchor_waited=True, cgroup_empty=True, executor_uid=UID,
            core_uid=UID-1, nonprivileged_project_write=kind!='no_activation', no_new_privileges=kind!='no_activation',
            core_read_denied=kind!='no_activation', business_keys_selected=kind!='no_activation', detached_descendant_created=kind=='normal',
            no_business_before_activation=fake is not None, business_started=complete['started'],
            cancelled=complete['cancelled'], cancellation=complete['cancellation'], exit_code=complete['exit_code'])
    finally:
        parent.close(); endpoint.close(); installation.close()
        for fd in (stdout, stderr, out, err):
            if fd is not None:
                try: os.close(fd)
                except OSError: pass
        if child is not None:
            if kind == 'cancel_after_exit' and child.poll() is None: child.send_signal(signal.SIGCONT)
            if child.poll() is None: child.send_signal(signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: job.kill(); child.kill(); child.wait()
            child.stderr.close()
        if job.fd is not None:
            job.kill(); assert job.empty(3); job.close_empty()
        if source_fd is not None:os.close(source_fd)
        if control is not None:
            try:control.sendall(b'finish')
            except OSError:pass
            control.close()
        if fake is not None:
            if fake.poll() is None:fake.terminate()
            fake.wait(timeout=3);fake.stderr.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--report', required=True)
    args = parser.parse_args(); os.umask(0o077)
    base, jobs = scope(); fixture = ServiceFixture(); root = None
    report = dict(passed=False, actual_core=False, actual_provider=False, durable_claim_qualified=False,
                  live_activation=False, scope_memory_limit_bytes=int((base/'memory.max').read_text()))
    try:
        package, profile, core, project = prepare(fixture, jobs); root = Root(jobs)
        report['cases'] = [run_case(fixture, package, profile, project, core, root, kind) for kind in ('normal','timeout','cancel','cancel_after_exit','activate','no_activation')]
        report['source_files_sha256'] = {name: hashlib.sha256((ROOT/'v2/provider-broker/codex_service'/name).read_bytes()).hexdigest()
            for name in ('workspace_anchor.py','workspace_cgroup.py','workspace_custody.py','workspace_environment.py')}
        report['scope_memory_peak_bytes'] = int((base/'memory.peak').read_text()); report['passed'] = True
    except BaseException as error:
        report.update(error_type=type(error).__name__, error=str(error)); raise
    finally:
        if root is not None: root.close()
        fixture.close(); jobs.rmdir(); report['disposable_data_removed'] = True
        Path(args.report).write_text(json.dumps(report,indent=2)+'\n'); Path(args.report).chmod(0o600)
    print(json.dumps({'passed':True,'kernel_component_only':True,'cases':6}))


if __name__ == '__main__': main()
