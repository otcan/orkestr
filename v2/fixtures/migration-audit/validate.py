#!/usr/bin/env python3
"""Audit-fixture checks only; no product imports, storage writes or dispatch."""
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True).encode()).hexdigest()


def unique(rows, key):
    keys = [key(row) for row in rows]
    require(len(keys) == len(set(keys)), "duplicate identity")
    return {key(row): row for row in rows}


def acyclic(edges):
    def visit(node, path):
        require(node not in path, "cycle")
        for parent in edges[node]:
            require(parent in edges, "orphan")
            visit(parent, path | {node})
    for node in edges:
        visit(node, set())


def validate(data):
    require(data['audit_version'] == 1, 'version')
    require(data['dispatch_allowed'] is False, 'dispatch forbidden')
    threads = unique(data['threads'], lambda r: r['id'])
    unique(data['threads'], lambda r: r['publicRef'])
    edges = {k: [v['parentThreadId']] if v['parentThreadId'] else []
             for k, v in threads.items()}
    acyclic(edges)
    for row in threads.values():
        root = row
        while root['parentThreadId']:
            parent = threads[root['parentThreadId']]
            require(parent['ownerUserId'] == row['ownerUserId'], 'cross-owner')
            root = parent
        require(row['rootThreadId'] == root['id'], 'root mismatch')
    messages = unique(data['messages'], lambda r: (r['thread_id'], r['id']))
    unique(data['messages'], lambda r: (r['thread_id'], r['position']))
    message_edges = {}
    for key, row in messages.items():
        require(row['thread_id'] in threads, 'orphan message')
        parent_key = (row['thread_id'], row['parent_message_id'])
        message_edges[key] = [parent_key] if row['parent_message_id'] else []
        if row['parent_message_id']:
            require(parent_key in messages, 'orphan message parent')
            require(messages[parent_key]['position'] < row['position'], 'parent order')
    acyclic(message_edges)
    tasks = unique(data['tasks'], lambda r: r['id'])
    runs = unique(data['runs'], lambda r: r['id'])
    acyclic({k: v['dependencies'] for k, v in tasks.items()})
    for task in tasks.values():
        require(task['threadId'] in threads and task['runId'] in runs, 'orphan task')
        for dependency in task['dependencies']:
            require(tasks[dependency]['projectId'] == task['projectId'], 'cross-project')
    unique(data['effects'], lambda r: r['effect_key'])
    for effect in data['effects']:
        require(effect['run_id'] in runs, 'orphan effect')
    unique(data['resources'], lambda r: (r['resource_type'], r['resource_id']))
    for artifact in data['artifacts']:
        relative = PurePosixPath(artifact['fixture_relative_path'])
        require(not relative.is_absolute() and '..' not in relative.parts, 'unsafe artifact')
        path = (ROOT / str(relative)).resolve()
        require(path.is_relative_to(ROOT), 'escaping artifact')
        require(path.is_file(), 'missing artifact')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == artifact['sha256'],
                'artifact hash')
    expected = data['expected']
    require(len(threads) == expected['thread_count'], 'thread count')
    require(len(messages) == expected['message_count'], 'message count')
    ordered = sorted((r for r in messages.values() if r['thread_id'] == 'fixture-root'),
                     key=lambda r: r['position'])
    require([r['id'] for r in ordered] == expected['root_message_order'], 'message order')
    journal_states = {'queued', 'running', 'succeeded', 'cancelled'}
    runtime_states = {'queued', 'starting', 'running', 'cancel_requested', 'blocked',
                      'succeeded', 'failed', 'cancelled'}
    require(sorted({t['state'] for t in tasks.values()} - journal_states)
            == expected['unsupported_task_states'], 'task state gaps')
    require(sorted({r['state'] for r in runs.values()} - runtime_states)
            == expected['unsupported_run_states'], 'run state gaps')
    require(expected['effects_disposition'] == 'quarantined_history_only', 'effects')
    require(expected['target_contract'] is None, 'no import contract')
    require(set(expected['exclusions']) == {'credentials', 'sessions', 'routes', 'leases',
                                          'approval_authority', 'retry_schedules'}, 'exclusions')


def main():
    source = ROOT / 'cases.json'
    before = source.read_bytes()
    data = json.loads(before)
    validate(data)
    # Pure audit identity exercise, not a durable import journal implementation.
    identities = [(data['source_instance'], 'message', r['thread_id'], r['id'])
                  for r in data['messages']]
    require(len(set(identities)) == 3, 'composite identity collapsed')
    first = {key: digest(row) for key, row in zip(identities, data['messages'])}
    second = {key: digest(row) for key, row in zip(identities, data['messages'])}
    require(first == second, 'repeat digest differs')
    changed = copy.deepcopy(data['messages'][0])
    changed['data']['text'] = 'Conflicting synthetic content'
    require(first[identities[0]] != digest(changed), 'conflict undetected')
    mutations = {
        'orphan': lambda d: d['threads'][1].update(parentThreadId='fixture-missing'),
        'cycle': lambda d: d['threads'][0].update(parentThreadId='fixture-worker'),
        'ownership': lambda d: d['threads'][1].update(ownerUserId='fixture-other-owner'),
        'root': lambda d: d['threads'][1].update(rootThreadId='fixture-worker'),
        'duplicate-position': lambda d: d['messages'][1].update(position=1),
        'message-parent': lambda d: d['messages'][1].update(parent_message_id='fixture-missing'),
        'task-cycle': lambda d: d['tasks'][0].update(dependencies=['fixture-task-2']),
        'run-reference': lambda d: d['tasks'][0].update(runId='fixture-missing'),
        'unknown-state': lambda d: d['runs'][0].update(state='fixture-future-state'),
        'traversal': lambda d: d['artifacts'][0].update(fixture_relative_path='../outside'),
        'missing-artifact': lambda d: d['artifacts'][0].update(fixture_relative_path='artifacts/missing'),
        'hash': lambda d: d['artifacts'][0].update(sha256='0' * 64),
        'dispatch': lambda d: d.update(dispatch_allowed=True),
    }
    for name, mutate in mutations.items():
        bad = copy.deepcopy(data)
        mutate(bad)
        try:
            validate(bad)
        except ValueError:
            continue
        raise ValueError('negative case accepted: ' + name)
    require(source.read_bytes() == before, 'fixture mutated')
    print(f'PASS: fixture, composite identity/repeat/conflict checks, {len(mutations)} negative cases; no writes or effects')


if __name__ == '__main__':
    main()
