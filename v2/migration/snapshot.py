"""Inert migration interchange validation. This is not a Core storage schema."""
import hashlib
import json
from pathlib import Path, PurePosixPath

VERSION = 1
MAX_BYTES = 16 * 1024 * 1024
KINDS = {'project', 'thread', 'message', 'task', 'run', 'result', 'resource',
         'artifact', 'timer', 'route', 'approval', 'effect', 'automation', 'job'}
FORBIDDEN = {'credentials', 'password', 'token', 'access_token', 'refresh_token',
             'cookie', 'cookies', 'session', 'session_state', 'private_key',
             'authorization', 'lease_holder', 'lease_expires_at', 'route_target',
             'phone', 'chat_id', 'endpoint', 'args_json', 'notification_target'}


class Invalid(ValueError):
    pass


def need(condition, code):
    if not condition:
        raise Invalid(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True, allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def read_json(path):
    need(path.is_file() and not path.is_symlink(), 'unsafe_json_file')
    need(path.stat().st_size <= MAX_BYTES, 'snapshot_too_large')
    raw = path.read_bytes()
    need(len(raw) <= MAX_BYTES, 'snapshot_too_large')
    try:
        return json.loads(raw, object_pairs_hook=strict_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(Invalid('nonfinite')))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise Invalid('invalid_json') from error


def fields(value, required):
    need(isinstance(value, dict) and set(value) == set(required), 'unexpected_fields')


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def no_secrets(value):
    if isinstance(value, dict):
        for key, item in value.items():
            need(key.lower().replace('-', '_') not in FORBIDDEN, 'excluded_field')
            no_secrets(item)
    elif isinstance(value, list):
        for item in value:
            no_secrets(item)
    # A structural denylist is not a text/secret scanner. Exporter review is required.


def identity(record):
    return canonical([record['kind'], record['key']]).decode()


def safe_file(root, relative):
    need(isinstance(relative, str) and '\\' not in relative, 'unsafe_path')
    posix = PurePosixPath(relative)
    need(relative == posix.as_posix() and not posix.is_absolute()
         and bool(posix.parts) and '..' not in posix.parts, 'unsafe_path')
    current = root
    for part in posix.parts:
        current = current / part
        need(not current.is_symlink(), 'symlink_forbidden')
    need(current.resolve().is_relative_to(root.resolve()), 'path_escape')
    need(current.is_file(), 'missing_file')
    return current


def validate_document(document, root):
    fields(document, {'version', 'source_instance', 'snapshot_id', 'origin',
                      'source_version', 'schema_versions', 'consistency', 'records', 'artifacts', 'counts', 'digest'})
    need(type(document['version']) is int and document['version'] == VERSION, 'version')
    need(nonempty(document['source_instance']) and nonempty(document['snapshot_id']), 'identity')
    need(nonempty(document['source_version']), 'source_version')
    need(isinstance(document['schema_versions'], dict) and bool(document['schema_versions'])
         and all(nonempty(k) and nonempty(v) for k, v in document['schema_versions'].items()),
         'schema_versions')
    need(document['origin'] in {'legacy', 'v2_delta'}, 'origin')
    body = {k: v for k, v in document.items() if k != 'digest'}
    need(document['digest'] == sha(body), 'manifest_digest')
    consistency = document['consistency']
    fields(consistency, {'method', 'watermark', 'segments', 'export_receipt'})
    need(consistency['method'] in {'synthetic', 'coordinated_snapshot'}, 'consistency_method')
    need(nonempty(consistency['watermark']) and nonempty(consistency['export_receipt']), 'consistency_receipt')
    segments = consistency['segments']
    need(isinstance(segments, dict) and bool(segments), 'segments')
    need(all(nonempty(k) and v == consistency['watermark'] for k, v in segments.items()),
         'inconsistent_watermark')
    records = document['records']
    need(isinstance(records, list), 'records')
    identities, counts = set(), {}
    for record in records:
        fields(record, {'kind', 'key', 'owner', 'scope', 'source_state', 'references', 'payload'})
        need(nonempty(record['kind']) and isinstance(record['key'], list)
             and bool(record['key']) and all(nonempty(v) for v in record['key']), 'record_key')
        need(record['owner'] is None or nonempty(record['owner']), 'owner')
        need(record['scope'] is None or nonempty(record['scope']), 'scope')
        need(record['source_state'] is None or nonempty(record['source_state']), 'source_state')
        need(isinstance(record['payload'], dict), 'payload')
        need(isinstance(record['references'], list), 'references')
        for ref in record['references']:
            fields(ref, {'relation', 'kind', 'key'})
            need(nonempty(ref['relation']) and nonempty(ref['kind'])
                 and isinstance(ref['key'], list) and bool(ref['key'])
                 and all(nonempty(v) for v in ref['key']), 'reference_key')
        key = identity(record)
        need(key not in identities, 'duplicate_identity')
        identities.add(key)
        counts[record['kind']] = counts.get(record['kind'], 0) + 1
        if record['kind'] == 'message':
            need(len(record['key']) == 2, 'message_composite_key')
            need(type(record['payload'].get('position')) is int
                 and record['payload']['position'] >= 0, 'message_position')
        need(record['kind'].lower() not in {'credential', 'credentials', 'session', 'sessions',
             'auth', 'profile', 'browser_profile', 'provider_profile', 'private_key'},
             'excluded_record_kind')
        no_secrets(record['payload'])
    need(document['counts'] == counts, 'record_counts')
    need(isinstance(document['artifacts'], list), 'artifacts')
    paths = set()
    for artifact in document['artifacts']:
        fields(artifact, {'path', 'sha256', 'bytes'})
        need(artifact['path'] not in paths, 'duplicate_artifact')
        paths.add(artifact['path'])
        path = safe_file(root, artifact['path'])
        need(type(artifact['bytes']) is int and 0 <= artifact['bytes'] <= MAX_BYTES,
             'artifact_size')
        need(path.stat().st_size == artifact['bytes'], 'artifact_size')
        need(hashlib.sha256(path.read_bytes()).hexdigest() == artifact['sha256'], 'artifact_digest')
    return document


def load(root):
    root = Path(root)
    need(root.is_dir() and not root.is_symlink(), 'snapshot_root')
    # Explicit copied bundle only. No database, home discovery or API is opened.
    return validate_document(read_json(root / 'snapshot.json'), root)
