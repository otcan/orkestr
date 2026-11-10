"""Operator-installed native desktop controller, invoked through authenticated host tools.

An operator descriptor binds one conversation, its existing desktop grant, one
local framebuffer service, and private output paths. No browser profiles,
password stores, shell commands or provider credentials are read.
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
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


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
    require(set(value) == fields and value['format'] == 'orkestr-desktop-control-v1', 'controller_configuration')
    uri = urllib.parse.urlsplit(value['v2_url'])
    require(uri.scheme == 'http' and uri.hostname == '127.0.0.1' and uri.port and
            value['v2_url'] == f'http://127.0.0.1:{uri.port}', 'controller_loopback_required')
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', value['desktop_slug']) and
            re.fullmatch(r'[a-zA-Z0-9_.@-]+\.service', value['framebuffer_unit']), 'controller_target_invalid')
    for key in ('conversation_id', 'v1_thread_id'):
        uuid.UUID(value[key])
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
            raise ValueError('controller_lease_refused_' + str(error.code)) from None

    def binding(self):
        value = self.call()['binding']
        c = self.config
        require(value['conversation_id'] == c['conversation_id'] and
                value['v1_thread_id'] == c['v1_thread_id'] and
                c['desktop_slug'] in value['desktop_slugs'] and value['grant_issued'],
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


def argument_shape(operation, values):
    counts = {'start': 0, 'status': 0, 'screenshot': 0, 'release': 0, 'move': 2, 'click': 3, 'key': 1, 'type': 1}
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
    if operation not in ('start', 'status'):
        uuid.UUID(session_id)
    directory = Path(config['state_directory'])
    journal = directory / ('request-' + request_id + '.json')
    if operation == 'status':
        previous = json.loads(read(journal))
        return {'ok': True, 'state': previous['state'], 'session_id': previous.get('session_id'),
                'result': previous.get('result'), 'automatic_retry': False}
    fingerprint = hashlib.sha256(json.dumps([operation, values, session_id], separators=(',', ':')).encode()).hexdigest()
    if journal.exists():
        previous = json.loads(read(journal))
        require(previous['fingerprint'] == fingerprint, 'controller_request_id_conflict')
        require(previous['state'] == 'complete', 'controller_action_outcome_unknown_no_retry')
        return {**previous['result'], 'duplicate': True}
    lease = Lease(config)
    lease.binding()
    target = framebuffer_identity(config) if operation != 'release' else None
    if operation == 'start':
        session_id = str(uuid.uuid4())
        state_path = directory / ('session-' + session_id + '.json')
        # Persist intent before acquiring. A lost answer is reconciled, never retried automatically.
        write(journal, {'state': 'intent', 'fingerprint': fingerprint})
        acquired = lease.call('acquire', {'ttl_ms': 300000, 'purpose': 'owner-authorized-native-desktop'})
        state = {'session_id': session_id, 'target': target, 'fencing_token': acquired['fencing_token'],
                 'conversation_id': config['conversation_id'], 'desktop_slug': config['desktop_slug'], 'state': 'active'}
        write(state_path, state)
        replace(journal, {'state': 'intent', 'fingerprint': fingerprint, 'session_id': session_id})
    else:
        state_path = directory / ('session-' + session_id + '.json')
        state = json.loads(read(state_path))
        require(state['state'] == 'active' and state['session_id'] == session_id and
                state['conversation_id'] == config['conversation_id'] and
                state['desktop_slug'] == config['desktop_slug'] and
                (operation == 'release' or state['target'] == target),
                'controller_session_or_target_changed')
        lease.call('heartbeat', {'fencing_token': state['fencing_token'], 'extend_ttl_ms': 300000})
        write(journal, {'state': 'intent', 'fingerprint': fingerprint})
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
    parser.add_argument('operation', choices=['start', 'status', 'screenshot', 'release', 'move', 'click', 'key', 'type'])
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
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z0-9_]+', str(error)) else type(error).__name__
        print(json.dumps({'ok': False, 'error': reason, 'reconcile_before_retry': True}))
        raise SystemExit(1)
