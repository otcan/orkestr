"""Credential files for provider sign-in. Runs only under the executor identity.

Reads the CLI's private temporary home and replaces the working credential.
Nothing here returns credential bytes to a caller.
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import time

from .contract import require

CREDENTIAL_LIMIT = 2 * 1024 * 1024
LABEL = re.compile(r'[A-Za-z0-9._+@ -]{1,254}')
# `codex logout` unlinks auth.json, which a bind mount refuses and which would
# strand the source path outside the namespace. This shape reads as signed out.
CODEX_SIGNED_OUT = b'{"OPENAI_API_KEY":null,"tokens":null,"last_refresh":null}\n'


def prepare_home(root, name):
    """Executor-side. One login per provider, so older residue is an old crash."""
    root = Path(root)
    root.mkdir(mode=0o700, exist_ok=True)
    info = os.lstat(root)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700, 'provider_login_temp_custody')
    for stale in root.glob(name + '-*'):
        shutil.rmtree(stale, ignore_errors=True)
    home = root / (name + '-' + secrets.token_hex(12))
    home.mkdir(mode=0o700)
    (home / ('codex' if name == 'codex' else 'claude')).mkdir(mode=0o700)
    return home


def _read_private(path, limit=CREDENTIAL_LIMIT):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'provider_login_credential_shape')
        return os.read(fd, limit + 1)
    finally:
        os.close(fd)


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        require(count > 0, 'provider_login_short_write')
        view = view[count:]


def in_place(target, data):
    """Keep the inode: a bind mount cannot be renamed over, and running natives
    hold that inode. New bytes land first and the tail is cut after, so a reader
    never finds an empty file; the same inode restores on failure."""
    fd = os.open(target, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'provider_login_target_type')
        previous = os.read(fd, CREDENTIAL_LIMIT + 1)
        try:
            require(os.pwrite(fd, data, 0) == len(data), 'provider_login_short_write')
            os.ftruncate(fd, len(data))
            os.fsync(fd)
        except BaseException:
            try:
                os.pwrite(fd, previous, 0)
                os.ftruncate(fd, len(previous))
                os.fsync(fd)
            except OSError:
                pass  # Report the original failure; the caller keeps failing closed.
            raise
    finally:
        os.close(fd)


def replace_file(target, data, mode=0o600):
    target = Path(target)
    temporary = target.with_name('.' + target.name + '.' + secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        try:
            _write_all(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(temporary, target)
    except OSError as error:
        try:
            os.unlink(temporary)
        except OSError:
            pass  # The rename may already have consumed it.
        if error.errno != errno.EBUSY:
            raise
        in_place(target, data)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _locked(directory, seconds=5):
    """Coordinate with Codex's own refresh writer when its locks exist."""
    held = []
    deadline = time.monotonic() + seconds
    for name in ('auth.lock', 'auth.json.lock'):
        try:
            fd = os.open(Path(directory) / name, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        held.append(fd)
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, 'provider_login_lock_busy')
                time.sleep(.05)
    return held


def _release(held):
    for fd in held:
        os.close(fd)


def codex_method(value):
    """Which credential a parsed auth.json really holds, or None.

    Not `codex login status`: it prints "Logged in using ChatGPT" for `{}` and
    for null tokens, including the signed-out shape written here."""
    if type(value) is not dict:
        return None
    if type(value.get('OPENAI_API_KEY')) is str and value['OPENAI_API_KEY']:
        return 'api_key'
    tokens = value.get('tokens')
    if type(tokens) is dict and type(tokens.get('access_token')) is str and tokens['access_token']:
        return 'chatgpt'
    return None


def claude_valid(value):
    oauth = value.get('claudeAiOauth') if type(value) is dict else None
    return type(oauth) is dict and type(oauth.get('accessToken')) is str and bool(oauth['accessToken'])


def commit_codex(home, target):
    raw = _read_private(Path(home) / 'codex/auth.json')
    require(codex_method(json.loads(raw)) == 'chatgpt', 'provider_login_credential_shape')
    held = _locked(Path(target).parent)
    try:
        replace_file(target, raw)
    finally:
        _release(held)


def commit_claude(home, account):
    source = Path(home) / 'claude'
    raw = _read_private(source / '.credentials.json')
    require(claude_valid(json.loads(raw)), 'provider_login_credential_shape')
    replace_file(Path(account) / '.credentials.json', raw)
    _merge_claude_account(source / '.claude.json', Path(account) / '.claude.json')


def _merge_claude_account(source, target):
    """Carry the signed-in account label; every other saved setting is kept."""
    try:
        account = json.loads(_read_private(source)).get('oauthAccount')
    except (OSError, ValueError, AttributeError):
        return
    if type(account) is not dict:
        return
    try:
        existing = json.loads(_read_private(target))
    except FileNotFoundError:
        existing = {}
    except (OSError, ValueError):
        return  # An unreadable account file is left alone; the login still holds.
    if type(existing) is not dict:
        return
    existing['oauthAccount'] = account
    replace_file(target, json.dumps(existing).encode())


def signout_codex(target):
    held = _locked(Path(target).parent)
    try:
        replace_file(target, CODEX_SIGNED_OUT)
    finally:
        _release(held)


def status_codex(target):
    try:
        method = codex_method(json.loads(_read_private(target)))
    except FileNotFoundError:
        method = None
    except ValueError:
        method = None
    return dict(signed_in=method is not None, method=method)


def status_claude(raw):
    """Closed projection of `auth status --json`; a missing login exits nonzero."""
    try:
        value = json.loads(raw)
    except ValueError:
        return dict(signed_in=False, method=None)
    if type(value) is not dict:
        return dict(signed_in=False, method=None)
    label = lambda key: value[key] if type(value.get(key)) is str and LABEL.fullmatch(value[key]) else None
    return dict(signed_in=value.get('loggedIn') is True, method=label('authMethod'),
                account=label('email'), subscription=label('subscriptionType'))
