"""Mutation-free registry metadata boundary; no connector helpers or credentials.

The embedding service supplies a trusted current-owner check and a server-owned
registry descriptor. Neither is accepted from an HTTP body. No route is mounted.
"""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import stat

MAX_BYTES = 1024 * 1024
MAX_CONNECTIONS = 1024
CAPABILITIES = ('gmail_read', 'gmail_send', 'gmail_actions', 'gmail_drafts',
                'calendar_read', 'calendar_actions')


@dataclass(frozen=True)
class CurrentAccount:
    """Projection returned only by a trusted request-bound auth adapter."""
    user_id: str
    kind: str = 'user'
    machine: bool = False
    anonymous: bool = False


@dataclass(frozen=True)
class RegistryDescriptor:
    owner: str
    path: Path


class RegistryRefused(ValueError):
    """Generic refusal deliberately excludes source values and paths."""


def _owner(check, expected):
    # A bound adapter must revalidate its session and return its ordinary account projection.
    # Machine/operator/admin-role scope fallback must not be implemented here.
    value = check()
    if (not isinstance(value, CurrentAccount) or value.kind != 'user'
            or value.machine is not False or value.anonymous is not False
            or type(value.user_id) is not str or not value.user_id or value.user_id != expected):
        raise RegistryRefused('current owner required')


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RegistryRefused('duplicate registry key')
        result[key] = value
    return result


def _open(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path.name != 'google-workspace-connections.json':
        raise RegistryRefused('trusted registry descriptor required')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)


def _project(raw, owner):
    if type(raw) is not dict or raw.get('schemaVersion') != 1 or type(raw.get('schemaVersion')) is not int:
        raise RegistryRefused('unsupported registry version')
    if raw.get('ownerUserId') != owner:
        raise RegistryRefused('registry owner mismatch')
    rows = raw.get('connections')
    if type(rows) is not list or len(rows) > MAX_CONNECTIONS:
        raise RegistryRefused('unsupported registry bounds')
    result = {'format_version': 1, 'connections': len(rows),
              'capabilities': dict.fromkeys(CAPABILITIES, 0),
              'unknown_capability_connections': 0,
              'health': dict.fromkeys(('connected', 'disconnected', 'error', 'unknown'), 0),
              'use_mode': dict.fromkeys(('default', 'available', 'explicit_only', 'unknown'), 0),
              'configuration_only': True, 'activity_proven': False,
              'provider_readiness_verified': False}
    seen = set()
    for row in rows:
        if type(row) is not dict or row.get('ownerUserId') != owner:
            raise RegistryRefused('connection owner mismatch')
        identity = row.get('connectionId') or row.get('accountId')
        if type(identity) is not str or not identity.strip() or identity.strip() in seen:
            raise RegistryRefused('invalid connection identity')
        seen.add(identity.strip())
        caps = row.get('capabilities', [])
        if type(caps) is not list or len(caps) > 128 or any(type(v) is not str for v in caps):
            raise RegistryRefused('unsupported capabilities')
        caps = {v.strip() for v in caps}
        for cap in CAPABILITIES:
            result['capabilities'][cap] += int(cap in caps)
        result['unknown_capability_connections'] += int(bool(caps - set(CAPABILITIES)))
        for field, output in (('healthState', 'health'), ('useMode', 'use_mode')):
            value = row.get(field)
            bucket = value if type(value) is str and value in result[output] else 'unknown'
            result[output][bucket] += 1
    return result


def read_registry_metadata(descriptor, current_owner):
    """Recheck current auth before opening and immediately before delivery.

    Missing/legacy/unowned/malformed files refuse, never initialize or normalize.
    One bounded file snapshot; no cross-store or live provider readiness claim.
    """
    if not isinstance(descriptor, RegistryDescriptor) or type(descriptor.owner) is not str or not descriptor.owner:
        raise RegistryRefused('trusted registry descriptor required')
    _owner(current_owner, descriptor.owner)
    fd = None
    try:
        fd = _open(descriptor.path)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_BYTES:
            raise RegistryRefused('unsupported registry file')
        chunks = bytearray()
        while len(chunks) <= MAX_BYTES:
            chunk = os.read(fd, min(65536, MAX_BYTES + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        after = os.fstat(fd)
        key = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if key(before) != key(after) or len(chunks) > MAX_BYTES:
            raise RegistryRefused('registry changed or oversized')
        raw = json.loads(chunks, object_pairs_hook=_pairs,
                         parse_constant=lambda _: (_ for _ in ()).throw(RegistryRefused('nonfinite registry')))
        result = _project(raw, descriptor.owner)
        _owner(current_owner, descriptor.owner)
        return result
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError):
        raise RegistryRefused('registry unavailable or malformed') from None
    finally:
        if fd is not None:
            os.close(fd)
