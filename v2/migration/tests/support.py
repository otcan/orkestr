import hashlib
import json
from pathlib import Path
from snapshot import sha


def record(kind, key, state=None, references=None, payload=None):
    return {'kind': kind, 'key': [key] if isinstance(key, str) else key,
            'owner': 'fixture-owner', 'scope': 'fixture-project', 'source_state': state,
            'references': references or [], 'payload': payload or {}}


def ref(kind, key, relation='parent'):
    return {'relation': relation, 'kind': kind, 'key': [key] if isinstance(key, str) else key}


def document():
    records = [
        record('project', 'fixture-project'),
        record('thread', 'fixture-root'),
        record('thread', 'fixture-worker', references=[ref('thread', 'fixture-root')]),
        record('message', ['fixture-root', 'fixture-message-1'], payload={'position': 1, 'cursor': 7, 'text': 'Synthetic request'}),
        record('message', ['fixture-root', 'fixture-message-2'], references=[ref('message', ['fixture-root', 'fixture-message-1'])], payload={'position': 2, 'cursor': 11, 'text': 'Synthetic reply'}),
        record('task', 'fixture-task', 'needs_approval', [ref('thread', 'fixture-worker', 'thread')]),
        record('run', 'fixture-run', 'awaiting_approval'),
        record('result', 'fixture-result', references=[ref('run', 'fixture-run', 'run')]),
        record('resource', ['fixture-type', 'fixture-resource']),
        record('artifact', 'fixture-artifact', payload={'path': 'artifacts/example.txt'}),
        record('timer', 'fixture-timer', 'enabled'),
        record('route', 'fixture-route', 'active'),
        record('approval', 'fixture-approval', 'approved'),
        record('effect', 'fixture-effect', 'unknown', [ref('run', 'fixture-run', 'run')]),
        record('automation', 'fixture-automation', 'enabled'),
        record('job', 'fixture-job', 'registered'),
    ]
    value = {'version': 1, 'source_instance': 'fixture-instance', 'snapshot_id': 'fixture-snapshot',
             'source_version': 'fixture-source-v1', 'schema_versions': {'fixture': '1'},
             'origin': 'legacy', 'consistency': {'method': 'synthetic', 'watermark': 'fixture-watermark',
                 'segments': {'registry': 'fixture-watermark', 'history': 'fixture-watermark',
                              'jobs': 'fixture-watermark', 'resources': 'fixture-watermark'},
                 'export_receipt': 'fixture-only-not-a-live-export'},
             'records': records, 'artifacts': [], 'counts': {}}
    return seal(value)


def seal(value):
    counts = {}
    for row in value['records']:
        counts[row['kind']] = counts.get(row['kind'], 0) + 1
    value['counts'] = counts
    value['digest'] = sha({k: v for k, v in value.items() if k != 'digest'})
    return value


def write_bundle(root, value=None):
    root = Path(root)
    root.mkdir(exist_ok=True)
    value = document() if value is None else value
    artifact = root / 'artifacts'
    artifact.mkdir(exist_ok=True)
    content = b'Synthetic artifact.\n'
    (artifact / 'example.txt').write_bytes(content)
    value['artifacts'] = [{'path': 'artifacts/example.txt', 'bytes': len(content),
                           'sha256': hashlib.sha256(content).hexdigest()}]
    seal(value)
    (root / 'snapshot.json').write_text(json.dumps(value, indent=2) + '\n')
    return value
