#!/usr/bin/env python3
"""Move a V1 parent thread's worker sub-threads with the parent into V2.

  plan    read-only: list the parent's V1 workers and the proposed mapping
  apply   register links under the parent conversation, set dispositions,
          import each bundled worker's history as archived history and
          (only when asked) transfer retired workers' worktrees to V2

Mapping (docs/v2/legacy-workers.md):
  retired worker  -> archived history under the parent conversation
  active worker   -> finish_in_v1 (default) or, with --recreate, recreate_in_v2
                     (continued as a V2 Worker task after V1 retires it)
  worktree        -> exactly one writer; V1 -> none -> V2 only with
                     --transfer-worktree after V1 shows the worker retired

Dry-run is the default; --apply is required to write. Reports contain only
identifiers, states and counts, never titles, message text or paths.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_import  # noqa: E402
import v1_export  # noqa: E402
import v2_client  # noqa: E402

RETIRED_STATES = {'retired', 'retiring'}


class WorkerError(RuntimeError):
    pass


def _records(home):
    home = Path(home)
    db = home / 'threads.sqlite'
    if db.is_file():
        connection = sqlite3.connect(f'file:{quote(str(db))}?mode=ro', uri=True)
        try:
            return [json.loads(row[0]) for row in connection.execute('SELECT data FROM orkestr_threads ORDER BY id')]
        finally:
            connection.close()
    if (home / 'threads.json').is_file():
        value = json.loads((home / 'threads.json').read_bytes())
        return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []
    raise WorkerError('v1_registry_absent')


def _retired(record):
    return bool(record.get('retired')) or any(
        str(record.get(key) or '') in RETIRED_STATES
        for key in ('state', 'lifecycleState', 'workerStatus'))


def _text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


def read_workers(home, parent):
    """V1 workers of `parent` (thread-workers.js: same parent, not task agents)."""
    workers = []
    for record in _records(home):
        if record.get('parentThreadId') != parent or record.get('threadKind') == 'task-agent':
            continue
        index = record.get('workerIndex')
        path = _text(record.get('worktreePath'), 1024)
        workers.append({
            'source_thread_id': str(record['id']),
            'source_parent_thread_id': parent,
            'worker_index': index if isinstance(index, int) and index > 0 else None,
            'title': _text(record.get('title') or record.get('name'), 300) or str(record['id']),
            'source_state': 'retired' if _retired(record) else 'active',
            'branch': _text(record.get('branchName'), 255),
            'worktree_path': path if path and path.startswith('/') else None,
        })
    workers.sort(key=lambda w: (w['worker_index'] is None, w['worker_index'] or 0, w['source_thread_id']))
    return workers


def snapshot_id(workers):
    canonical = json.dumps(workers, sort_keys=True, separators=(',', ':')).encode()
    return 'workers-' + hashlib.sha256(canonical).hexdigest()[:32]


def plan(workers, recreate=(), transfer=()):
    ids = {w['source_thread_id']: w for w in workers}
    unknown = sorted((set(recreate) | set(transfer)) - set(ids))
    if unknown:
        raise WorkerError('unknown_worker')
    entries = []
    for worker in workers:
        wid, retired = worker['source_thread_id'], worker['source_state'] == 'retired'
        disposition = 'recreate_in_v2' if wid in recreate else ('archived' if retired else 'finish_in_v1')
        steps = []
        if wid in transfer:
            if not retired:
                raise WorkerError('transfer_requires_v1_retirement')
            if not worker['worktree_path']:
                raise WorkerError('transfer_requires_worktree')
            steps = ['release_v1_worktree', 'claim_v2_worktree']
        entries.append({'source_thread_id': wid, 'source_state': worker['source_state'],
                        'disposition': disposition, 'worktree': steps or 'unchanged',
                        'has_worktree': bool(worker['worktree_path'])})
    return {'workers': len(workers),
            'active': sum(w['source_state'] == 'active' for w in workers),
            'retired': sum(w['source_state'] == 'retired' for w in workers),
            'export_threads': [w['source_thread_id'] for w in workers],
            'entries': entries}


def _link(links, wid):
    return next(w for w in links['workers'] if w['record']['source_thread_id'] == wid)


def apply(client, conversation, workers, report, source_instance, bundle=None, write=False):
    base = f'/api/v2/conversations/{conversation}/legacy-workers'
    result = {'mode': 'apply' if write else 'dry_run', 'conversation_id': conversation,
              'snapshot_id': snapshot_id(workers), 'plan': report}
    if not write:
        if bundle:
            manifest, messages = v1_export.load(bundle)
            result['history'] = [history_import.import_thread(
                client, manifest, messages, t['thread_id'], conversation=conversation)['delta']
                for t in manifest['threads'] if t['thread_id'] in report['export_threads']]
        return result
    receipt = client.post(base, {'source_instance': source_instance,
                                 'snapshot_id': result['snapshot_id'], 'workers': workers})
    result['registered'] = {i['source_thread_id']: i['outcome'] for i in receipt['items']}
    conflicts = sorted(k for k, v in result['registered'].items() if v == 'conflict')
    transitions = []
    for entry in report['entries']:
        wid = entry['source_thread_id']
        if wid in conflicts:
            continue
        actions = []
        current = _link(client.get(base), wid)
        if current['disposition'] != entry['disposition']:
            actions.append({'action': 'set_disposition', 'disposition': entry['disposition']})
        if entry['worktree'] != 'unchanged':
            actions += [{'action': a} for a in entry['worktree']]
        for action in actions:
            if action['action'] == 'release_v1_worktree' and current['worktree_writer'] != 'v1':
                continue
            if action['action'] == 'claim_v2_worktree' and current['worktree_writer'] == 'v2':
                continue
            current = client.post(base + '/transition', dict(
                action, source_instance=source_instance, source_thread_id=wid,
                expected_revision=current['revision']))
            transitions.append({'source_thread_id': wid, 'action': action['action'],
                                'worktree_writer': current['worktree_writer'],
                                'disposition': current['disposition']})
    result['transitions'] = transitions
    result['conflicts'] = conflicts
    if bundle:
        manifest, messages = v1_export.load(bundle)
        result['history'] = [
            {k: v for k, v in history_import.import_thread(
                client, manifest, messages, t['thread_id'], conversation=conversation, apply=True).items()
             if k in ('thread_id', 'delta', 'result', 'verified')}
            for t in manifest['threads'] if t['thread_id'] in report['export_threads']]
    return result


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = root.add_subparsers(dest='command', required=True)
    for name in ('plan', 'apply'):
        command = commands.add_parser(name)
        command.add_argument('--v1-home', required=True)
        command.add_argument('--parent', required=True)
        command.add_argument('--recreate', action='append', default=[], help='active worker to recreate in V2')
        command.add_argument('--transfer-worktree', action='append', default=[],
                             help='retired worker whose worktree V2 takes over')
        if name == 'apply':
            command.add_argument('--conversation', required=True, help="the parent's V2 conversation")
            command.add_argument('--bundle', help='thread_history.py v1-export bundle of the workers')
            command.add_argument('--source-instance', default='orkestr-v1')
            command.add_argument('--v2-url', required=True)
            command.add_argument('--origin')
            command.add_argument('--credentials-file', required=True)
            command.add_argument('--apply', action='store_true')
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        workers = read_workers(args.v1_home, args.parent)
        report = plan(workers, args.recreate, args.transfer_worktree)
        if args.command == 'plan':
            result = report
        else:
            username, password = v2_client.read_credentials(args.credentials_file)
            client = v2_client.Client(args.v2_url, origin=args.origin)
            client.login(username, password)
            try:
                result = apply(client, args.conversation, workers, report, args.source_instance,
                               bundle=args.bundle, write=args.apply)
            finally:
                client.close()
    except (WorkerError, v1_export.ExportError) as failure:
        print(json.dumps({'ok': False, 'code': str(failure)}), file=sys.stderr)
        return 2
    except v2_client.ApiError as failure:
        print(json.dumps({'ok': False, 'code': failure.code, 'status': failure.status}), file=sys.stderr)
        return 2
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as failure:
        print(json.dumps({'ok': False, 'code': type(failure).__name__}), file=sys.stderr)
        return 2
    print(json.dumps({'ok': True, 'result': result}, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
