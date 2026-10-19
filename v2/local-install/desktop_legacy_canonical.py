"""Tagged canonical JSON for the explicitly trusted retired-cohort contract."""
import hashlib
import json
import math
import struct

from desktop_restore import MAX_BYTES, RecoveryError, no_duplicates

MAX_SAFE = 2**53 - 1
COHORT_FORMAT = 'orkestr-desktop-retired-cohort-v1'
ADOPTION_FORMAT = 'orkestr-desktop-legacy-adoption-v1'


def canonical(value):
    chunks, size, nodes = [], 0, 0

    def emit(data):
        nonlocal size
        size += len(data)
        if size > MAX_BYTES:
            raise RecoveryError('canonical output exceeds bound')
        chunks.append(data)

    def encode(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 100000 or depth > 64:
            raise RecoveryError('canonical JSON complexity exceeded')
        if item is None:
            emit(b'n')
        elif type(item) is bool:
            emit(b't' if item else b'f')
        elif type(item) in (int, float):
            if (not math.isfinite(item) or abs(item) > MAX_SAFE
                    or (item == 0 and math.copysign(1, item) < 0)):
                raise RecoveryError('noncanonical number')
            emit(b'd' + struct.pack('>d', item).hex().encode())
        elif isinstance(item, str):
            try:
                data = item.encode('utf-8', errors='strict')
            except UnicodeError as error:
                raise RecoveryError('unpaired surrogate') from error
            emit(b's' + str(len(data)).encode() + b':' + data)
        elif isinstance(item, list):
            emit(b'a' + str(len(item)).encode() + b':[')
            for child in item:
                encode(child, depth + 1)
            emit(b']')
        elif isinstance(item, dict):
            try:
                keys = sorted(item, key=lambda key: key.encode('utf-8', errors='strict'))
            except (UnicodeError, AttributeError) as error:
                raise RecoveryError('canonical object requires Unicode string keys') from error
            emit(b'o' + str(len(keys)).encode() + b':{')
            for key in keys:
                encode(key, depth + 1)
                encode(item[key], depth + 1)
            emit(b'}')
        else:
            raise RecoveryError('not a JSON value')

    encode(value, 0)
    return b''.join(chunks)


def parse(raw):
    if len(raw) > MAX_BYTES:
        raise RecoveryError('JSON input exceeds bound')
    def integer(text):
        value = int(text)
        if abs(value) > MAX_SAFE or text == '-0':
            raise RecoveryError('noncanonical number')
        return value
    def floating(text):
        value = float(text)
        if (not math.isfinite(value) or abs(value) > MAX_SAFE
                or (value == 0 and math.copysign(1, value) < 0)):
            raise RecoveryError('noncanonical number')
        return value
    try:
        text = raw.decode('utf-8', errors='strict')
        value = json.loads(text, object_pairs_hook=no_duplicates, parse_int=integer,
                           parse_float=floating, parse_constant=lambda _: (_ for _ in ()).throw(
                               RecoveryError('nonfinite JSON')))
        canonical(value)
        return value
    except (ValueError, UnicodeError, RecursionError, OverflowError) as error:
        raise RecoveryError('invalid bounded canonical JSON') from error


def retired_digest(source_digest, floor, records):
    ordered = sorted(records, key=lambda lease: lease['id'].encode('utf-8'))
    payload = dict(format=COHORT_FORMAT, sourceSha256=source_digest,
                   generationFloor=floor, retiredRecords=ordered)
    return hashlib.sha256(canonical(payload)).hexdigest()
