"""Operator-installed native desktop controller, invoked through authenticated host tools.

An operator descriptor binds one conversation, its existing desktop grant, one
local framebuffer service, and private output paths. No browser profiles,
password stores, shell commands or provider credentials are read. A descriptor
may also name the host's desk-ensure program, which `start` runs under its own
fresh lease when the desk was stopped (for example by an idle-stop policy).
"""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# A start stays inside the 90 s host-command budget: desk-ensure gets what is left
# after the lease calls, minus a reserve for the framebuffer to settle and the screenshot.
START_BUDGET_SECONDS = 80.0
START_RESERVE_SECONDS = 20.0
DESK_ENSURE_BUDGET_MS = 45000
DESK_ENSURE_MINIMUM_MS = 5000
FRAMEBUFFER_SETTLE_SECONDS = 10.0
# A framebuffer that a desk start is still bringing up reports one of these.
FRAMEBUFFER_SETTLING = {'controller_framebuffer_inactive', 'controller_framebuffer_pid',
                        'controller_listener_not_owned'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def require(value, reason):
    if not value:
        raise ValueError(reason)


def protected(path, directory=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'controller_path_alias')
    for p in (path, *path.parents):
        s = p.lstat()
        require(s.st_uid == 0 and not s.st_mode & 0o022 and not p.is_symlink(), 'controller_custody')
    s = path.stat()
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1,
            'controller_object_type')
    return path


def read(path):
    path = protected(path)
    require(path.stat().st_size <= 65536, 'controller_file_bound')
    return path.read_bytes()


def write(path, value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def replace(path, value):
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    write(temporary, value)
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def configuration(path):
    value = json.loads(read(path))
    fields = {'format', 'v2_url', 'conversation_id', 'v1_thread_id', 'desktop_slug', 'grant_file',
              'framebuffer_port', 'framebuffer_unit', 'state_directory', 'output_directory',
              'output_uid', 'output_gid', 'broker_file', 'broker_uid'}
    require(fields <= set(value) <= fields | {'desk_ensure'} and value['format'] == 'orkestr-desktop-control-v1',
            'controller_configuration')
    if 'desk_ensure' in value:
        # Shape only: the digest is checked when a start runs the program, so a
        # desk-ensure update never blocks status or release of a live session.
        desk_ensure_entry(value)
    uri = urllib.parse.urlsplit(value['v2_url'])
    require(uri.scheme == 'http' and uri.hostname == '127.0.0.1' and uri.port and
            value['v2_url'] == f'http://127.0.0.1:{uri.port}', 'controller_loopback_required')
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', value['desktop_slug']) and
            re.fullmatch(r'[a-zA-Z0-9_.@-]+\.service', value['framebuffer_unit']), 'controller_target_invalid')
    uuid.UUID(value['conversation_id'])
    require(isinstance(value['v1_thread_id'], str) and
            re.fullmatch(r'[A-Za-z0-9._:-]{1,200}', value['v1_thread_id']),
            'controller_thread_id_invalid')
    require(all(type(value[k]) is int and value[k] > 0 for k in ('output_uid', 'output_gid', 'broker_uid')),
            'controller_output_identity')
    require(type(value['framebuffer_port']) is int and 1 <= value['framebuffer_port'] <= 65535,
            'controller_port_invalid')
    for key in ('state_directory', 'output_directory'):
        protected(value[key], True)
    return value


class Lease:
    def __init__(self, config):
        self.config = config
        lines = read(config['grant_file']).decode().splitlines()
        values = [shlex.split(line.split('=', 1)[1]) for line in lines
                  if line.removeprefix('export ').startswith('ORKESTR_V2_DESKTOP_GRANT=')]
        require(len(values) == 1 and len(values[0]) == 1 and re.fullmatch('[0-9a-f]{64}', values[0][0]),
                'controller_grant_invalid')
        self.grant = values[0][0]

    def call(self, operation=None, body=None):
        c = self.config
        url = c['v2_url'] + '/api/v2/conversations/' + c['conversation_id'] + '/desktops'
        if operation:
            url += '/' + c['desktop_slug'] + '/' + operation
        headers = {'X-Orkestr-Desktop-Grant': self.grant, 'Content-Type': 'application/json'}
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                         headers=headers, method='POST' if body is not None else 'GET')
        try:
            with HTTP.open(request, timeout=50) as response:
                raw = response.read(1024**2 + 1)
                require(len(raw) <= 1024**2, 'controller_lease_response_bound')
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError('controller_lease_refused_' + str(error.code)) from None

    def inspect_binding(self):
        document = self.call()
        value = document.get('binding') or {}
        c = self.config
        slugs = value.get('desktop_slugs')
        slugs = slugs if isinstance(slugs, list) and all(isinstance(s, str) for s in slugs) else []
        # Explicit projection only: never expose grants, lease tokens, provider
        # state, raw broker responses, or unrelated inventory/session records.
        return {
            'conversation_id': c['conversation_id'],
            'v1_thread_id': c['v1_thread_id'],
            'desktop_slug': c['desktop_slug'],
            'binding_conversation_matches': value.get('conversation_id') == c['conversation_id'],
            'binding_thread_matches': value.get('v1_thread_id') == c['v1_thread_id'],
            'bound_desktop_slugs': slugs,
            'grant_issued': value.get('grant_issued') is True,
            'shared_with_all_chats': document.get('shared_with_all_chats') is True,
            'configured_slug_bound': c['desktop_slug'] in slugs,
        }

    def binding(self):
        value = self.inspect_binding()
        c = self.config
        require(value['binding_conversation_matches'] and value['binding_thread_matches'] and
                value['grant_issued'] and
                (value['configured_slug_bound'] or value['shared_with_all_chats']),
                'controller_binding_changed')
        # This existing service-owned integration supplies only the operator
        # API credential. Check current operate rights as well as acquire;
        # shadow-mode deployments must not turn a lease into an input grant.
        path = Path(c['broker_file'])
        require(path.resolve(strict=True) == path, 'controller_broker_alias')
        for ancestor in path.parents:
            info = ancestor.stat()
            require(info.st_uid in (0, c['broker_uid']) and not info.st_mode & 0o022,
                    'controller_broker_ancestry')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == c['broker_uid'] and
                    not info.st_mode & 0o077 and info.st_nlink == 1 and info.st_size <= 65536,
                    'controller_broker_custody')
            broker = json.loads(stream.read(65537))
        uri = urllib.parse.urlsplit(broker['v1_url'])
        require(uri.scheme == 'http' and uri.hostname == '127.0.0.1' and uri.port and
                broker['v1_url'].rstrip('/') == f'http://127.0.0.1:{uri.port}', 'controller_broker_loopback')
        request = urllib.request.Request(broker['v1_url'].rstrip('/') + '/api/threads/' +
            c['v1_thread_id'] + '/desktop-grants', headers={'Authorization': 'Bearer ' + broker['bearer_token']})
        with HTTP.open(request, timeout=8) as response:
            raw = response.read(1024**2 + 1)
        require(len(raw) <= 1024**2, 'controller_permission_response_bound')
        authorize_permissions(json.loads(raw)['grants'], c)


def authorize_permissions(grants, config):
    now = datetime.datetime.now(datetime.timezone.utc)
    def current(row):
        expires = row.get('expiresAt')
        return expires is None or datetime.datetime.fromisoformat(expires.replace('Z', '+00:00')) > now
    require(any(row.get('desktopSlug') == config['desktop_slug'] and
                row.get('threadId') == config['v1_thread_id'] and row.get('revokedAt') is None and
                {'acquire', 'operate'} <= set(row.get('permissions', [])) and current(row) for row in grants),
            'controller_operate_not_granted')


def framebuffer_identity(config):
    value = subprocess.check_output(['/usr/bin/systemctl', 'show', config['framebuffer_unit'],
        '-p', 'MainPID,ActiveState,FragmentPath', '--no-pager'], text=True, timeout=5)
    unit = dict(line.split('=', 1) for line in value.splitlines() if '=' in line)
    require(unit.get('ActiveState') == 'active', 'controller_framebuffer_inactive')
    protected(unit['FragmentPath'])
    pid = int(unit['MainPID'])
    require(pid > 1, 'controller_framebuffer_pid')
    proc = Path('/proc') / str(pid)
    fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    require(fields[0] not in ('Z', 'X'), 'controller_framebuffer_dead')
    executable = (proc / 'exe').resolve(strict=True)
    protected(executable)
    sockets = set()
    for fd in (proc / 'fd').iterdir():
        try:
            target = os.readlink(fd)
            if target.startswith('socket:['):
                sockets.add(target[8:-1])
        except FileNotFoundError:
            pass
    address = f'0100007F:{config["framebuffer_port"]:04X}'
    listeners = [line.split()[9] for line in (proc / 'net/tcp').read_text().splitlines()[1:]
                 if len(line.split()) > 9 and line.split()[1] == address and line.split()[3] == '0A']
    require(len(listeners) == 1 and listeners[0] in sockets, 'controller_listener_not_owned')
    require(os.readlink(proc / 'ns/net') == os.readlink('/proc/self/ns/net'), 'controller_network_namespace')
    return {'pid': pid, 'start_ticks': int(fields[19]), 'listener_inode': listeners[0],
            'executable_sha256': hashlib.sha256(executable.read_bytes()).hexdigest()}


def desk_ensure_entry(config):
    entry = config['desk_ensure']
    require(isinstance(entry, dict) and set(entry) == {'path', 'sha256'} and isinstance(entry['path'], str) and
            isinstance(entry['sha256'], str) and re.fullmatch('[0-9a-f]{64}', entry['sha256']),
            'controller_desk_ensure_invalid')
    return entry


def desk_ensure_program(config):
    """The pinned, Root-owned desk-ensure executable named by the descriptor."""
    entry = desk_ensure_entry(config)
    program = protected(entry['path'])
    require(program.stat().st_mode & 0o100, 'controller_desk_ensure_invalid')
    require(program.stat().st_size <= 1024**2 and
            hashlib.sha256(program.read_bytes()).hexdigest() == entry['sha256'], 'controller_desk_ensure_changed')
    return program


def run_desk_ensure(config, lease, budget_ms):
    """Start the configured desk once, inside the caller's own held lease.

    The program receives only the desk, V1 thread and fencing version, never
    the grant or the fencing token, and answers with one JSON line. It runs in
    its own process group, which is killed as a whole if it overruns.
    """
    require(isinstance(lease, dict) and lease.get('v1_thread_id') == config['v1_thread_id'] and
            type(lease.get('fencing_version')) is int and lease['fencing_version'] > 0,
            'controller_lease_response_invalid')
    program = desk_ensure_program(config)
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1',
           'ORKESTR_DESKTOP_SLUG': config['desktop_slug'], 'ORKESTR_DESKTOP_THREAD_ID': lease['v1_thread_id'],
           'ORKESTR_DESKTOP_FENCING_VERSION': str(lease['fencing_version'])}
    child = subprocess.Popen([str(program), '--slug', config['desktop_slug'], '--budget-ms', str(budget_ms)],
                             env=env, cwd='/', stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    try:
        stdout, _ = child.communicate(timeout=budget_ms / 1000 + 5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise ValueError('controller_desk_start_timeout') from None
    lines = (stdout or '').strip().splitlines()
    try:
        answer = json.loads(lines[-1]) if lines else None
    except ValueError:
        answer = None
    if child.returncode == 0 and isinstance(answer, dict) and answer.get('ok') is True:
        return
    code = answer.get('error') if isinstance(answer, dict) else None
    raise ValueError('controller_' + code if isinstance(code, str) and re.fullmatch(r'desk_[a-z_]{1,40}', code)
                     else 'controller_desk_start_failed')


def ensure_framebuffer(config, lease, deadline, clock=time.monotonic, pause=time.sleep):
    """Return the framebuffer identity, running desk-ensure first if the desk is stopped."""
    try:
        return framebuffer_identity(config)
    except ValueError as error:
        if str(error) != 'controller_framebuffer_inactive':
            raise
    budget_ms = int(min(DESK_ENSURE_BUDGET_MS, (deadline - clock() - START_RESERVE_SECONDS) * 1000))
    require(budget_ms >= DESK_ENSURE_MINIMUM_MS, 'controller_start_budget_exhausted')
    run_desk_ensure(config, lease, budget_ms)
    deadline = clock() + FRAMEBUFFER_SETTLE_SECONDS
    while True:
        try:
            return framebuffer_identity(config)
        except ValueError as error:
            if str(error) not in FRAMEBUFFER_SETTLING or clock() >= deadline:
                raise
        pause(0.5)


def failure_reason(error):
    return str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z0-9_]+', str(error)) else type(error).__name__


def abandon_start(lease, acquired, journal, fingerprint, state_path, error):
    """Release the lease of a start that failed; a start never sends input.

    Never raises, so the original error stays visible. If the release cannot be
    confirmed, the intent journal stays as it is and `status` keeps reporting
    an unknown outcome.
    """
    try:
        lease.call('release', {'fencing_token': acquired['fencing_token'],
                               'reason': 'native-desktop-controller-start-failed'})
    except Exception:
        return
    try:
        replace(journal, {'state': 'failed', 'fingerprint': fingerprint, 'error': failure_reason(error)})
        if state_path.exists():
            state = json.loads(read(state_path))
            state['state'] = 'released'
            replace(state_path, state)
    except Exception:
        pass


def argument_shape(operation, values):
    counts = {'inspect-binding': 0, 'start': 0, 'status': 0, 'screenshot': 0, 'release': 0, 'move': 2, 'click': 3, 'key': 1, 'type': 1}
    require(operation in counts and len(values) == counts[operation], 'controller_action_arguments')
    if operation in ('move', 'click'):
        require(all(re.fullmatch(r'[0-9]{1,5}', x) for x in values), 'controller_coordinates_invalid')
        require(all(int(x) <= 65535 for x in values[:2]), 'controller_coordinates_invalid')
    if operation == 'click':
        require(1 <= int(values[2]) <= 5, 'controller_button_invalid')
    if operation == 'key':
        require(values[0] in {'Return', 'Tab', 'Escape', 'BackSpace', 'Delete', 'Home', 'End',
                'Left', 'Up', 'Right', 'Down', 'Page_Up', 'Page_Down', 'Shift_L',
                'Control_L', 'Alt_L', 'space'}, 'controller_key_invalid')
    if operation == 'type':
        require(0 < len(values[0]) <= 1024 and all(c.isprintable() for c in values[0]), 'controller_text_invalid')


def execute(config, operation, values, session_id, request_id):
    argument_shape(operation, values)
    uuid.UUID(request_id)
    if operation not in ('start', 'status', 'inspect-binding'):
        uuid.UUID(session_id)
    if operation == 'inspect-binding':
        return {'ok': True, 'operation': operation, **Lease(config).inspect_binding()}
    directory = Path(config['state_directory'])
    journal = directory / ('request-' + request_id + '.json')
    if operation == 'status':
        if not journal.exists():
            # Intent is persisted before any lease or input, so nothing ran under this ID.
            return {'ok': True, 'state': 'not_recorded', 'session_id': None, 'result': None, 'automatic_retry': False}
        previous = json.loads(read(journal))
        return {'ok': True, 'state': previous['state'], 'session_id': previous.get('session_id'),
                'result': previous.get('result'), 'automatic_retry': False,
                **({'error': previous['error']} if 'error' in previous else {})}
    fingerprint = hashlib.sha256(json.dumps([operation, values, session_id], separators=(',', ':')).encode()).hexdigest()
    if journal.exists():
        previous = json.loads(read(journal))
        require(previous['fingerprint'] == fingerprint, 'controller_request_id_conflict')
        require(previous['state'] != 'failed', 'controller_request_failed_use_new_request_id')
        require(previous['state'] == 'complete', 'controller_action_outcome_unknown_no_retry')
        return {**previous['result'], 'duplicate': True}
    deadline = time.monotonic() + START_BUDGET_SECONDS
    lease = Lease(config)
    lease.binding()
    autostart = operation == 'start' and 'desk_ensure' in config
    target = framebuffer_identity(config) if operation != 'release' and not autostart else None
    if operation == 'start':
        session_id = str(uuid.uuid4())
        state_path = directory / ('session-' + session_id + '.json')
        # Persist intent before acquiring. A lost answer is reconciled, never retried automatically.
        write(journal, {'state': 'intent', 'fingerprint': fingerprint})
        acquired = lease.call('acquire', {'ttl_ms': 300000, 'purpose': 'owner-authorized-native-desktop'})
        try:
            if autostart:
                # Checked under the new lease, so an idle-stop cannot race the start.
                target = ensure_framebuffer(config, acquired.get('lease'), deadline)
            state = {'session_id': session_id, 'target': target, 'fencing_token': acquired['fencing_token'],
                     'conversation_id': config['conversation_id'], 'desktop_slug': config['desktop_slug'],
                     'state': 'active'}
            write(state_path, state)
            replace(journal, {'state': 'intent', 'fingerprint': fingerprint, 'session_id': session_id})
            return perform(config, operation, values, session_id, state, state_path, target, lease, journal,
                           fingerprint)
        except Exception as error:
            abandon_start(lease, acquired, journal, fingerprint, state_path, error)
            raise
    state_path = directory / ('session-' + session_id + '.json')
    state = json.loads(read(state_path))
    require(state['state'] == 'active' and state['session_id'] == session_id and
            state['conversation_id'] == config['conversation_id'] and
            state['desktop_slug'] == config['desktop_slug'] and
            (operation == 'release' or state['target'] == target),
            'controller_session_or_target_changed')
    lease.call('heartbeat', {'fencing_token': state['fencing_token'], 'extend_ttl_ms': 300000})
    write(journal, {'state': 'intent', 'fingerprint': fingerprint})
    return perform(config, operation, values, session_id, state, state_path, target, lease, journal, fingerprint)


def perform(config, operation, values, session_id, state, state_path, target, lease, journal, fingerprint):
    """Run one journaled action on a held session and record its result."""
    result = {'ok': True, 'session_id': session_id, 'desktop_slug': config['desktop_slug'], 'operation': operation}
    if operation == 'release':
        lease.call('release', {'fencing_token': state['fencing_token'], 'reason': 'native-desktop-controller-finished'})
        state['state'] = 'released'
        replace(state_path, state)
    else:
        module_path = Path(__file__).with_name('desktop_framebuffer.py')
        protected(module_path)
        spec = importlib.util.spec_from_file_location('desktop_framebuffer', module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        desktop = module.Desktop(config['framebuffer_port'])
        try:
            desktop.initialize()
            require(framebuffer_identity(config) == target, 'controller_target_changed')
            if operation in ('move', 'click'):
                desktop.pointer(*map(int, values))
            elif operation == 'key':
                desktop.key(values[0])
            elif operation == 'type':
                desktop.text(values[0])
            raw = desktop.screenshot()
            require(framebuffer_identity(config) == target, 'controller_target_changed_after_action')
        finally:
            desktop.close()
        image = Path(config['output_directory']) / (uuid.uuid4().hex + '.png')
        fd = os.open(image, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), config['output_uid'], config['output_gid'])
        result.update(screenshot_path=str(image), screenshot_sha256=hashlib.sha256(raw).hexdigest(),
                      width=desktop.width, height=desktop.height)
    replace(journal, {'state': 'complete', 'fingerprint': fingerprint, 'result': result})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configuration', required=True)
    parser.add_argument('--request-id', required=True)
    parser.add_argument('--session-id', default='')
    parser.add_argument('operation', choices=['inspect-binding', 'start', 'status', 'screenshot', 'release', 'move', 'click', 'key', 'type'])
    parser.add_argument('values', nargs='*')
    args = parser.parse_args()
    require(os.geteuid() == 0 and sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode,
            'controller_protected_invocation_required')
    protected(Path(__file__).resolve())
    config = configuration(args.configuration)
    lock = Path(config['state_directory']) / 'controller.lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        protected(lock)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(execute(config, args.operation, args.values, args.session_id, args.request_id)))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, urllib.error.URLError, subprocess.SubprocessError) as error:
        # A failure after intent may follow a real click. Inspect the journal;
        # never repeat it with a new request ID merely because capture failed.
        print(json.dumps({'ok': False, 'error': failure_reason(error), 'reconcile_before_retry': True}))
        raise SystemExit(1)
