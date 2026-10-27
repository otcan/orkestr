"""Optional passive Codex quota projection. No execution or account authority.

Codex app-server reports account usage through `account/rateLimits/updated`
(a sparse RateLimitSnapshot). This projects only the account-wide five-hour
and weekly windows into the same closed `orkestr-provider-quota-v1` cache the
Claude broker writes, as `codex.json`, so V1's footer/quota API keeps fresh
Codex values after Codex work moved from V1 threads to this broker.
"""
import json
import math
import os
from pathlib import Path
import secrets
import stat
import time
import uuid
from protocol import Refused

FORMAT = 'orkestr-provider-quota-v1'
PROVIDER = 'codex'
FILENAME = 'codex.json'
PERIODS = ('five_hour', 'seven_day')
FIELDS = {'used_percent', 'resets_at', 'status', 'observed_at'}
# The account-wide bucket. Model-specific aliases (another limitId, usually
# with normalModelSlug) are separate quotas and never substitute for it.
ACCOUNT_LIMITS = (None, 'codex')


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def period(minutes):
    if type(minutes) is not int or minutes <= 0:
        return None
    if minutes <= 360:
        return 'five_hour'
    return 'seven_day' if minutes >= 10080 else None


def project(snapshot, observed_at=None):
    """Select known account-wide windows; never copy native/account objects."""
    observed_at = int(time.time() * 1000) if observed_at is None else observed_at
    if type(snapshot) is not dict or snapshot.get('limitId') not in ACCOUNT_LIMITS:
        return {}
    result = {}
    for key in ('primary', 'secondary'):
        raw = snapshot.get(key)
        if type(raw) is not dict:
            continue  # Sparse update: an absent window keeps its last value.
        name = period(raw.get('windowDurationMins'))
        used = raw.get('usedPercent')
        reset = raw.get('resetsAt')
        if name is None or name in result or not (number(used) and used <= 100):
            continue
        reset = reset if number(reset) and reset > 0 else None
        if reset is not None and reset >= 1e12:
            reset /= 1000
        # No status is inferred from a percentage or rateLimitReachedType.
        result[name] = dict(used_percent=used, resets_at=reset, status=None, observed_at=observed_at)
    return result


def canonical(value):
    return type(value) is str and str(uuid.UUID(value)) == value and uuid.UUID(value).int != 0


def valid_window(value):
    return type(value) is dict and set(value) == FIELDS \
        and (value['used_percent'] is None or number(value['used_percent']) and value['used_percent'] <= 100) \
        and (value['resets_at'] is None or number(value['resets_at']) and value['resets_at'] > 0) \
        and value['status'] in ('allowed', 'allowed_warning', 'rejected', None) \
        and type(value['observed_at']) is int and value['observed_at'] > 0


class QuotaSink:
    """Atomic, bounded cache outside sealed packages and private Core state.

    The protected operator package binds this directory and opaque account ref
    to its Core owner. The native never receives either setting. A lock refusal
    drops metadata rather than blocking the provider; callers isolate all errors.
    """
    def __init__(self, directory, owner, account_ref, uid):
        self.directory, self.owner, self.account_ref, self.uid = Path(directory), owner, account_ref, uid

    @classmethod
    def optional(cls, package, native_config=None):
        try:
            value = getattr(package, 'runtime', {}).get('codex_quota_projection')
            if type(value) is not dict or set(value) != {'directory', 'account_ref'} \
                    or not canonical(package.owner) or not canonical(value['account_ref']):
                return None
            directory = Path(value['directory'])
            if not directory.is_absolute() or directory.resolve(strict=True) != directory:
                return None
            # Sharing quota metadata must never relax Core/package custody.
            private_paths = [package.home, package.root, package.ledger_directory, package.endpoint.parent]
            if getattr(package, 'provider_home', None) is not None:
                private_paths.append(package.provider_home)
            if native_config is not None:
                workspace = getattr(native_config, 'workspace', None)
                if workspace is not None:
                    private_paths.append(Path(workspace))
                # The role's native account state (sandboxed auth.json lives here).
                state_root = getattr(getattr(native_config, 'profile', None), 'state_root', None)
                if state_root is not None:
                    private_paths.append(Path(state_root))
                environment = getattr(native_config, 'host_environment', None) or {}
                for key in ('HOME', 'CODEX_HOME'):
                    if type(environment.get(key)) is str and environment[key].startswith('/'):
                        private_paths.append(Path(environment[key]))
            for private in private_paths:
                if private == directory or private in directory.parents or directory in private.parents:
                    return None
            return cls(directory, package.owner, value['account_ref'], package.uid)
        except Refused:
            raise
        except Exception:
            return None  # Optional projection configuration never blocks execution.

    def _check(self, fd, directory=False):
        info = os.fstat(fd)
        if info.st_uid != self.uid or info.st_mode & 0o027 \
                or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1):
            raise ValueError('quota projection custody')

    def observe(self, owner, params):
        """The channel's callback: raw notification params in, closed windows out."""
        if type(params) is dict:
            self(owner, project(params.get('rateLimits')))

    def __call__(self, owner, windows):
        if owner != self.owner or not windows or set(windows) - set(PERIODS) \
                or not all(valid_window(value) for value in windows.values()):
            return
        import fcntl
        directory = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        lock = None
        temporary = None
        try:
            self._check(directory, True)
            # Its own lock: the Claude sink may share this directory.
            lock = os.open('.codex-quota.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            self._check(lock)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            previous = {}
            try:
                fd = os.open(FILENAME, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    self._check(fd)
                    data = os.read(fd, 8193)
                    if len(data) > 8192:
                        raise ValueError('quota projection bound')
                    old = json.loads(data)
                finally:
                    os.close(fd)
                if set(old) == {'format', 'provider', 'owner_id', 'account_ref', 'windows'} \
                        and old['format'] == FORMAT and old['provider'] == PROVIDER \
                        and old['owner_id'] == owner and old['account_ref'] == self.account_ref \
                        and type(old['windows']) is dict and not set(old['windows']) - set(PERIODS) \
                        and all(valid_window(value) for value in old['windows'].values()):
                    previous = old['windows']
            except FileNotFoundError:
                pass
            for name, value in windows.items():
                if value['observed_at'] >= previous.get(name, {}).get('observed_at', 0):
                    previous[name] = value
            data = json.dumps(dict(format=FORMAT, provider=PROVIDER, owner_id=owner,
                                   account_ref=self.account_ref, windows=previous), allow_nan=False).encode()
            temporary = '.codex-quota-' + secrets.token_hex(12)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640, dir_fd=directory)
            try:
                self._check(fd)
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        raise OSError('quota projection write')
                    view = view[written:]
            finally:
                os.close(fd)
            os.replace(temporary, FILENAME, src_dir_fd=directory, dst_dir_fd=directory)
            temporary = None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except OSError:
                    pass  # Never mask an interrupted native control/stop path.
            if lock is not None:
                os.close(lock)
            os.close(directory)
