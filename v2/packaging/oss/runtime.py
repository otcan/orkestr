"""Container PID1 and local administration. Uses the ordinary selected manager."""
import argparse
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capabilities import drop_child_capabilities, set_no_new_privileges

ROOT = Path('/opt/orkestr')
SOURCE = ROOT / 'source'
STATE = Path('/state')
UID = GID = 10001
PORT = 19822
METRICS_PORT = 19824  # loopback only; 19823 is the published nginx port
ORIGIN = 'http://127.0.0.1:19822'
SETUP = STATE / 'setup'
# Unconfigured-mode children are exec'd through util-linux setpriv: UID/GID
# 10001, no groups, empty inheritable/ambient/bounding sets (NNP is already
# set on PID1). PID1 itself keeps its capabilities so that, once configured,
# it can re-exec into the ordinary root manager without a container restart.
SETPRIV = ['/usr/bin/setpriv', '--reuid=10001', '--regid=10001', '--clear-groups',
           '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private_directory(path, uid=UID, mode=0o700):
    if not path.exists():
        path.mkdir(mode=mode)
        os.chown(path, uid, GID if uid else 0)
        path.chmod(mode)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid
            and stat.S_IMODE(info.st_mode) == mode, 'state directory custody refused')


def write_private(path, value, uid=UID):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        os.fchown(stream.fileno(), uid, GID if uid else 0)
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def initialize():
    import secrets
    require(os.geteuid() == 0, 'container manager must initialize as root')
    for root in (STATE, Path('/credentials')):
        require(root.resolve() == root and root.is_dir() and root.stat().st_uid == 0
                and not root.stat().st_mode & 0o022, 'root-managed named volume required')
    for parent, children in (
        (STATE, ('home', 'native', 'workspaces', 'claude-home', 'claude-tmp')),
        (Path('/credentials'), ('codex', 'claude', 'home')),
    ):
        for name in children:
            private_directory(parent / name)
    for name in ('data', 'provider-home'):
        private_directory(STATE / 'home' / name)
    private_directory(SETUP)
    for role in ('deep', 'fast', 'worker-0', 'worker-1', 'worker-2', 'worker-3', 'claude'):
        private_directory(STATE / 'native' / role)
        private_directory(STATE / 'workspaces' / role)
    private_directory(STATE / 'releases', 0, 0o755)
    token = STATE / 'bootstrap.token'
    if not token.exists() and not token.is_symlink():
        write_private(token, secrets.token_urlsafe(48))
    info = token.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == UID
            and stat.S_IMODE(info.st_mode) == 0o600, 'bootstrap custody refused')


def request(path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:19822' + path, data=data,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


def dropped_environment():
    return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'HOME': '/credentials/home', 'CODEX_HOME': '/credentials/codex',
            'PYTHONDONTWRITEBYTECODE': '1'}


def login(provider):
    initialize()
    drop_child_capabilities()
    env = dropped_environment()
    if provider == 'codex':
        argv = [str(ROOT / 'providers/codex'), 'login', '--device-auth']
    else:
        env['CLAUDE_CONFIG_DIR'] = '/credentials/claude'
        argv = [str(ROOT / 'providers/claude'), 'auth', 'login']
    # TTY belongs to the user; tokens are never read, copied or printed by us.
    return subprocess.call(argv, env=env, user=UID, group=GID, extra_groups=[], cwd='/credentials/home')


def logged_in(provider):
    env = dropped_environment()
    argv = [str(ROOT / 'providers' / provider)]
    if provider == 'codex':
        argv += ['login', 'status']
    else:
        argv += ['auth', 'status']
        env['CLAUDE_CONFIG_DIR'] = '/credentials/claude'
    result = subprocess.run(SETPRIV + argv, env=env, cwd='/credentials/home',
                            capture_output=True, timeout=30)
    if result.returncode != 0:
        return False
    if provider == 'claude':
        try:
            return json.loads(result.stdout).get('loggedIn') is True
        except (ValueError, AttributeError):
            return False
    return True


def record_configuration(owner_id, conversation_id, machine_token, claude):
    """Write the owner scope and timer token; shared by the CLI and browser setup."""
    import uuid
    require(not (STATE / 'owner.json').exists() and not (STATE / 'owner.json').is_symlink(),
            'already configured; automatic reconfiguration refused')
    require(type(owner_id) is str and str(uuid.UUID(owner_id)) == owner_id, 'owner identity refused')
    require(type(conversation_id) is str and 0 < len(conversation_id) <= 128
            and conversation_id.isprintable() and not conversation_id.isspace(), 'conversation identity refused')
    require(type(machine_token) is str and 16 <= len(machine_token) <= 512 and machine_token.isascii()
            and machine_token.isprintable() and ' ' not in machine_token, 'machine token refused')
    require(type(claude) is bool, 'provider selection refused')
    # A previous attempt may have stopped between files; owner.json is last.
    for name in ('timer.token', 'timer.json'):
        stale = STATE / name
        if stale.is_symlink() or stale.exists():
            stale.unlink()
    write_private(STATE / 'timer.token', machine_token)
    write_private(STATE / 'timer.json', json.dumps({'schema_version': 1, 'machine_token_file': str(STATE / 'timer.token')}))
    write_private(STATE / 'owner.json', json.dumps({'owner_id': owner_id,
                  'conversation_id': conversation_id, 'claude': claude}), 0)


def configure():
    import getpass
    initialize()
    drop_child_capabilities()
    require(not (STATE / 'owner.json').exists(), 'already configured; automatic reconfiguration refused')
    # Codex runs the Deep/Worker roles and is required. Claude is optional: when
    # its login is present it also serves Fast; otherwise Fast runs on Codex.
    require(logged_in('codex'), 'provider_login_required: run login codex (login claude is optional)')
    claude = logged_in('claude')
    credentials = {'username': input('Orkestr owner username: '), 'password': getpass.getpass('Orkestr owner password: ')}
    # The browser login supplies the authenticated owner UUID. No direct DB access.
    browser = request('/api/v2/browser/session', credentials, {'Origin': ORIGIN})
    machine = request('/api/v2/machine/session', credentials)
    require(browser['global_conversation_id'] == machine['global_conversation_id'], 'conversation identity mismatch')
    record_configuration(browser['owner_id'], browser['global_conversation_id'], machine['token'], claude)
    print('Owner scope verified. Providers: Codex' + (' and Claude.' if claude else
          ' only (Claude not signed in; Fast uses Codex).'))
    print('Orkestr activates the provider configuration automatically within a few seconds.')


def browser_configuration():
    """Apply the browser setup's request: verified owner scope from setup_service.py.

    The unprivileged setup service authenticated the owner (cookie + CSRF, then
    credentials for the machine token). PID1 accepts only this exact closed
    shape from a regular, single-link, provider-UID file, re-checks the Codex
    login itself and decides Claude itself.
    """
    path = SETUP / 'configure.json'
    if not path.exists() and not path.is_symlink():
        return False
    try:
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == UID
                and info.st_size <= 4096, 'setup request custody refused')
        value = json.loads(path.read_text())
        require(type(value) is dict and set(value) == {'owner_id', 'conversation_id', 'machine_token'},
                'setup request refused')
        require(logged_in('codex'), 'provider_login_required')
        record_configuration(value['owner_id'], value['conversation_id'], value['machine_token'],
                             logged_in('claude'))
        print('Owner scope verified from browser setup; activating providers.', flush=True)
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, RuntimeError) else 'setup request refused'
        print('Browser setup refused: ' + message, file=sys.stderr, flush=True)
        try:
            write_private(SETUP / 'configure-error', message)
        except OSError:
            pass
    finally:
        path.unlink(missing_ok=True)
    return True


def prepare(owner):
    import hashlib
    owner = dict(owner)
    # Configurations written before Claude became optional always included it.
    claude = owner.pop('claude', True)
    require(type(claude) is bool and set(owner) == {'owner_id', 'conversation_id'}, 'owner scope refused')
    pair = json.loads((ROOT / 'paired-artifacts.json').read_text())
    output = STATE / 'releases' / pair['source_commit']
    if output.exists():
        # Ordinary protected manager verifies the closed inventory before import.
        require(not output.is_symlink(), 'release alias refused')
        return output
    roles = {role: {'workspace': str(STATE / 'workspaces' / role),
                    'state_root': str(STATE / 'native' / role)}
             for role in ('deep', 'fast', 'worker-0', 'worker-1', 'worker-2', 'worker-3')}
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    plan = {'format': 'orkestr-v2-selected-service-plan-v1', 'output': str(output),
            'source_repository': str(SOURCE), 'pair': str(ROOT / 'paired-artifacts.json'),
            'pair_sha256': digest(ROOT / 'paired-artifacts.json'), 'server': str(ROOT / 'server'),
            'ui': str(ROOT / 'ui'), 'native': str(ROOT / 'providers/codex'),
            'native_sha256': digest(ROOT / 'providers/codex'), 'uid': UID, 'gid': GID,
            'home': str(STATE / 'home'), **roles['deep'],
            'auth_file': '/credentials/codex/auth.json', 'bootstrap_file': str(STATE / 'bootstrap.token'),
            'ledger_directory': str(STATE / 'ledger'), 'endpoint_directory': str(STATE / 'ipc'),
            **owner, 'namespace': 'oss-beta', 'supervisor_key': 'oss-beta-manager',
            'origin': ORIGIN, 'port': PORT, 'preserve_state': True,
            # The proxy listens on PORT + 1 (19823), the server's default metrics port.
            'metrics_port': METRICS_PORT,
            'roles': {'fast': roles['fast'], 'workers': [roles[f'worker-{i}'] for i in range(4)]},
            'host_full_access': {'providers': True, 'environment': dropped_environment()},
            'code_mode_host': str(ROOT / 'providers/codex-code-mode-host'),
            'code_mode_host_sha256': digest(ROOT / 'providers/codex-code-mode-host'),
            'claude': {'executable': str(ROOT / 'providers/claude'), 'account': '/credentials/claude',
                       'workspace': str(STATE / 'workspaces/claude'), 'home': str(STATE / 'claude-home'),
                       'temporary': str(STATE / 'claude-tmp'), 'fast': True, 'default': False},
            'timer_config': str(STATE / 'timer.json')}
    if not claude:
        del plan['claude']
    # Root-generated closed plan, no operator executable/path/env selectors.
    plan_file = STATE / ('plan-' + pair['source_commit'] + '.json')
    write_private(plan_file, json.dumps(plan), 0)
    subprocess.run(['/usr/bin/python3', '-I', '-S', '-B',
                    str(SOURCE / 'v2/packaging/service/selected.py'), '--plan', str(plan_file)],
                   check=True, env={'PATH': '/usr/bin:/bin', 'HOME': '/root', 'PYTHONDONTWRITEBYTECODE': '1'})
    return output


def stop(child):
    if child is not None and child.poll() is None:
        child.send_signal(signal.SIGTERM)
        child.wait(timeout=35)


def stop_all(children):
    for child in reversed(children):
        try:
            stop(child)
        except (OSError, subprocess.SubprocessError):
            child.kill()


def serve_configured(owner_file):
    info = owner_file.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600, 'owner scope custody refused')
    release = prepare(json.loads(owner_file.read_text()))
    ending = False
    def finish(*_):
        nonlocal ending
        ending = True
    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    children = []
    try:
        children.append(subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-B',
                        str(SOURCE / 'v2/packaging/oss/capabilities.py'), str(release)], cwd='/'))
        # The dedicated root manager got its own copy before PID1 drops Bnd.
        drop_child_capabilities()
        # Configured mode: the setup page and /api/v2/oss-setup are not routed.
        children.append(subprocess.Popen(['/usr/sbin/nginx', '-c', str(SOURCE / 'v2/packaging/oss/nginx.conf')],
                                         user=UID, group=GID, extra_groups=[]))
        while not ending:
            require(all(child.poll() is None for child in children), 'owned service exited; inspect container logs')
            time.sleep(0.2)
    finally:
        stop_all(children)


def setup_banner():
    token = (STATE / 'bootstrap.token').read_text()
    print('provider_login_required: open http://127.0.0.1:19822, choose First-time setup, then Connect models', flush=True)
    # Local container log only (docker logs); valid until the first owner exists.
    print('First-time setup token: ' + token, flush=True)


def serve_unconfigured(owner_file):
    """Until configured: plain server, browser setup service and setup proxy.

    Returns True when the owner scope was written and PID1 should re-exec
    into configured mode (no container restart)."""
    for stale in (SETUP / 'setup.sock', SETUP / 'configure.json', SETUP / 'configure-error'):
        if stale.is_symlink() or stale.exists():
            stale.unlink()
    setup_banner()
    ending = False
    def finish(*_):
        nonlocal ending
        ending = True
    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    children = []
    try:
        children.append(subprocess.Popen(SETPRIV + [str(ROOT / 'server')], cwd='/', env={
            **dropped_environment(), 'ORKESTR_V2_HOME': str(STATE / 'home/data'),
            'ORKESTR_V2_BIND': '127.0.0.1:19822', 'ORKESTR_V2_ORIGIN': ORIGIN,
            'ORKESTR_V2_UI_DIST': str(ROOT / 'ui'),
            'ORKESTR_V2_BOOTSTRAP_TOKEN': (STATE / 'bootstrap.token').read_text()}))
        children.append(subprocess.Popen(SETPRIV + ['/usr/bin/python3', '-I', '-S', '-B',
                        str(SOURCE / 'v2/packaging/oss/setup_service.py')], cwd='/credentials/home',
                        env=dropped_environment()))
        children.append(subprocess.Popen(SETPRIV + ['/usr/sbin/nginx', '-c',
                        str(SOURCE / 'v2/packaging/oss/nginx-setup.conf')], cwd='/', env={'PATH': '/usr/bin:/bin'}))
        while not ending:
            require(all(child.poll() is None for child in children), 'owned service exited; inspect container logs')
            browser_configuration()
            if owner_file.exists() or owner_file.is_symlink():
                return True
            time.sleep(0.2)
        return False
    finally:
        stop_all(children)


def serve():
    initialize()
    owner_file = STATE / 'owner.json'
    if owner_file.exists() or owner_file.is_symlink():
        return serve_configured(owner_file)
    if serve_unconfigured(owner_file):
        # Same PID 1, fresh interpreter, full original capabilities: the
        # ordinary configured start (prepare + root manager), no restart.
        os.execv('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S', '-B',
                 str(SOURCE / 'v2/packaging/oss/runtime.py'), 'serve'])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=('serve', 'login', 'configure', 'health'), nargs='?', default='serve')
    p.add_argument('provider', choices=('codex', 'claude'), nargs='?')
    a = p.parse_args()
    set_no_new_privileges()
    if a.action == 'health':
        require(request('/api/v2/health')['status'] == 'ok', 'health refused')
    elif a.action == 'login':
        require(a.provider is not None, 'provider required')
        return login(a.provider)
    elif a.action == 'configure':
        configure()
    else:
        serve()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RuntimeError as error:
        # require() messages are fixed local strings, never native/API payloads.
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, subprocess.SubprocessError):
        # Never echo native login stdout/errors, request bodies or credentials.
        print('Orkestr startup/action refused. Check the documented prerequisites and container service state.', file=sys.stderr)
        sys.exit(1)
