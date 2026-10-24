"""Optional passive numeric quota projection. No execution or account authority."""
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
PERIODS = ('five_hour', 'seven_day')
STATUSES = ('allowed', 'allowed_warning', 'rejected')
FIELDS = {'used_percent', 'resets_at', 'status', 'observed_at'}


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def project(info, observed_at=None):
    """Select known account-wide windows; never copy native/account objects."""
    observed_at = int(time.time() * 1000) if observed_at is None else observed_at
    windows = info.get('unifiedWindows', info.get('unified_windows', {}))
    windows = windows if type(windows) is dict else {}
    selected = info.get('rateLimitType', info.get('rate_limit_type'))
    result = {}
    for period in PERIODS:
        raw = windows.get(period)
        raw = raw if type(raw) is dict else {}
        direct = selected == period
        if not raw and not direct:
            continue
        utilization = raw.get('utilization')
        used = round(utilization * 100, 2) if number(utilization) and utilization <= 1 else None
        if used is None:
            value = raw.get('used_percent', raw.get('used_percentage'))
            used = value if number(value) and value <= 100 else None
        status = raw.get('status', info.get('status') if direct else None)
        status = status if status in STATUSES else None
        reset = raw.get('resetsAt', raw.get('resets_at'))
        if reset is None and direct:
            reset = info.get('resetsAt', info.get('resets_at'))
        reset = reset if number(reset) and reset > 0 else None
        if reset is not None and reset >= 1e12:
            reset /= 1000
        # No percent is inferred from status, tokens, plan or account metadata.
        if used is not None or reset is not None or status is not None:
            result[period] = dict(used_percent=used, resets_at=reset,
                                  status=status, observed_at=observed_at)
    return result


def canonical(value):
    return type(value) is str and str(uuid.UUID(value)) == value and uuid.UUID(value).int != 0


def valid_window(value):
    return type(value) is dict and set(value) == FIELDS \
        and (value['used_percent'] is None or number(value['used_percent']) and value['used_percent'] <= 100) \
        and (value['resets_at'] is None or number(value['resets_at']) and value['resets_at'] > 0) \
        and value['status'] in (*STATUSES, None) \
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
            value = package.runtime.get('claude_quota_projection')
            if type(value) is not dict or set(value) != {'directory', 'account_ref'} \
                    or not canonical(package.owner) or not canonical(value['account_ref']):
                return None
            directory = Path(value['directory'])
            if not directory.is_absolute() or directory.resolve(strict=True) != directory:
                return None
            # Sharing quota metadata must never relax Core/package custody.
            private_paths=[package.home, package.root, package.ledger_directory, package.endpoint_directory]
            if getattr(package,'provider_home',None) is not None:
                private_paths.append(package.provider_home)
            if native_config is not None:
                private_paths.extend(getattr(native_config,key) for key in ('account','home','temporary','workspace'))
                if native_config.host_full_access is not None:
                    private_paths.append(Path(native_config.host_full_access['HOME']))
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
            lock = os.open('.quota.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            self._check(lock)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            previous = {}
            try:
                fd = os.open('claude.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    self._check(fd)
                    data = os.read(fd, 8193)
                    if len(data) > 8192:
                        raise ValueError('quota projection bound')
                    old = json.loads(data)
                finally:
                    os.close(fd)
                if set(old) == {'format', 'provider', 'owner_id', 'account_ref', 'windows'} \
                        and old['format'] == FORMAT and old['provider'] == 'claude' \
                        and old['owner_id'] == owner and old['account_ref'] == self.account_ref \
                        and type(old['windows']) is dict and not set(old['windows']) - set(PERIODS) \
                        and all(valid_window(value) for value in old['windows'].values()):
                    previous = old['windows']
            except FileNotFoundError:
                pass
            for period, value in windows.items():
                if value['observed_at'] >= previous.get(period, {}).get('observed_at', 0):
                    previous[period] = value
            data = json.dumps(dict(format=FORMAT, provider='claude', owner_id=owner,
                                   account_ref=self.account_ref, windows=previous), allow_nan=False).encode()
            temporary = '.quota-' + secrets.token_hex(12)
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
            os.replace(temporary, 'claude.json', src_dir_fd=directory, dst_dir_fd=directory)
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
