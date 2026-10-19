"""Closed HTTP beta configuration grammar pinned to Runtime 1b2dc432b.

Shape validation grants no workspace, launcher, manager-peer or provider authority.
"""
import json
from pathlib import Path
import re
import uuid

from closure import require

FIELDS = {'schema_version', 'owner_id', 'conversation_id', 'manager_socket',
          'launcher', 'launcher_sha256', 'workspace', 'namespace', 'supervisor_key'}


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'duplicate beta config field')
        value[key] = item
    return value


def validate(raw):
    require(type(raw) is bytes and len(raw) <= 8192, 'bounded beta config required')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(RuntimeError('invalid beta number')))
    require(type(value) is dict and set(value) == FIELDS, 'closed beta config fields required')
    require(type(value['schema_version']) is int and value['schema_version'] == 1, 'beta schema version')
    for name in ('owner_id', 'conversation_id'):
        text = value[name]
        require(type(text) is str, 'beta UUID required')
        try:
            identifier = uuid.UUID(text)
        except ValueError:
            raise RuntimeError('beta UUID required') from None
        require(identifier.int != 0, 'nonnil beta UUID required')
    for name in ('manager_socket', 'launcher', 'workspace'):
        text = value[name]
        require(type(text) is str and '\x00' not in text and Path(text).is_absolute(), 'absolute beta path required')
    for name in ('namespace', 'supervisor_key'):
        require(type(value[name]) is str and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', value[name]), 'bounded beta identifier required')
    require(type(value['launcher_sha256']) is str and re.fullmatch('[0-9a-f]{64}', value['launcher_sha256']), 'beta launcher digest required')
    return value
