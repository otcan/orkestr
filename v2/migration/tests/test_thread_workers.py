"""Worker sub-thread mapping against a synthetic V1 registry and a fake V2."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import thread_workers  # noqa: E402

PARENT = 'aeef0000synthetic'


def record(wid, index, **extra):
    base = {'id': wid, 'parentThreadId': PARENT, 'threadKind': 'worker', 'workerIndex': index,
            'title': f'Synthetic / Worker {index}', 'branchName': f'orkestr/synthetic/w{index}',
            'worktreePath': f'/srv/example/worktrees/{PARENT}/{wid}', 'state': 'sleeping'}
    return base | extra


RECORDS = [
    {'id': PARENT, 'title': 'Synthetic'},
    record('w-active', 2),
    record('w-retired', 1, retired=True, state='retired', workerStatus='retired'),
    record('w-task', 3, threadKind='task-agent'),
    record('w-other', 1, parentThreadId='someone-else'),
]


class FakeLinks:
    """Minimal V2 legacy-worker API: registration defaults and transitions."""

    def __init__(self):
        self.links, self.calls = {}, []

    def get(self, path, query=None):
        return {'workers': list(self.links.values())}

    def post(self, path, body):
        self.calls.append((path.rsplit('/', 1)[-1], body.get('action')))
        if path.endswith('/transition'):
            link = self.links[body['source_thread_id']]
            assert body['expected_revision'] == link['revision']
            action = body['action']
            if action == 'set_disposition':
                link['disposition'] = body['disposition']
            elif action == 'release_v1_worktree':
                assert link['record']['source_state'] == 'retired' and link['worktree_writer'] == 'v1'
                link['worktree_writer'] = 'none'
            elif action == 'claim_v2_worktree':
                assert link['worktree_writer'] == 'none'
                link['worktree_writer'] = 'v2'
            link['revision'] += 1
            return dict(link)
        items = []
        for worker in body['workers']:
            known = self.links.get(worker['source_thread_id'])
            if known is None:
                retired = worker['source_state'] == 'retired'
                self.links[worker['source_thread_id']] = {
                    'record': worker, 'revision': 1, 'v2_task_id': None,
                    'disposition': 'archived' if retired else 'finish_in_v1',
                    'worktree_writer': 'v1' if worker['worktree_path'] else 'none'}
                items.append({'source_thread_id': worker['source_thread_id'], 'outcome': 'inserted'})
            else:
                items.append({'source_thread_id': worker['source_thread_id'], 'outcome': 'unchanged'})
        return {'items': items}


class ThreadWorkerTests(unittest.TestCase):
    def home(self, sqlite=False):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        if sqlite:
            db = sqlite3.connect(root / 'threads.sqlite')
            db.execute('create table orkestr_threads (id text primary key, data text not null)')
            db.executemany('insert into orkestr_threads values(?,?)', [(r['id'], json.dumps(r)) for r in RECORDS])
            db.commit()
            db.close()
        else:
            (root / 'threads.json').write_text(json.dumps(RECORDS))
        return root

    def test_reads_only_this_parents_workers_from_either_registry(self):
        for sqlite in (False, True):
            workers = thread_workers.read_workers(self.home(sqlite), PARENT)
            self.assertEqual([(w['source_thread_id'], w['source_state'], w['worker_index']) for w in workers],
                             [('w-retired', 'retired', 1), ('w-active', 'active', 2)])

    def test_plan_defaults_and_transfer_preconditions(self):
        workers = thread_workers.read_workers(self.home(), PARENT)
        report = thread_workers.plan(workers)
        self.assertEqual([(e['source_thread_id'], e['disposition'], e['worktree']) for e in report['entries']],
                         [('w-retired', 'archived', 'unchanged'), ('w-active', 'finish_in_v1', 'unchanged')])
        self.assertEqual(report['export_threads'], ['w-retired', 'w-active'])
        with self.assertRaises(thread_workers.WorkerError) as caught:
            thread_workers.plan(workers, transfer=['w-active'])
        self.assertEqual(str(caught.exception), 'transfer_requires_v1_retirement')
        with self.assertRaises(thread_workers.WorkerError):
            thread_workers.plan(workers, recreate=['unknown'])
        recreate = thread_workers.plan(workers, recreate=['w-active', 'w-retired'], transfer=['w-retired'])
        self.assertEqual(recreate['entries'][0]['worktree'], ['release_v1_worktree', 'claim_v2_worktree'])
        self.assertNotIn('Synthetic', json.dumps(report))

    def test_apply_registers_and_transfers_through_none(self):
        workers = thread_workers.read_workers(self.home(), PARENT)
        report = thread_workers.plan(workers, recreate=['w-retired'], transfer=['w-retired'])
        fake = FakeLinks()
        dry = thread_workers.apply(fake, 'c-1', workers, report, 'orkestr-v1')
        self.assertEqual((dry['mode'], fake.calls), ('dry_run', []))
        result = thread_workers.apply(fake, 'c-1', workers, report, 'orkestr-v1', write=True)
        self.assertEqual(result['registered'], {'w-retired': 'inserted', 'w-active': 'inserted'})
        self.assertEqual([(t['source_thread_id'], t['action']) for t in result['transitions']],
                         [('w-retired', 'set_disposition'), ('w-retired', 'release_v1_worktree'),
                          ('w-retired', 'claim_v2_worktree')])
        self.assertEqual(fake.links['w-retired']['worktree_writer'], 'v2')
        self.assertEqual(fake.links['w-active']['worktree_writer'], 'v1')
        # Rerun is idempotent: nothing to transition.
        again = thread_workers.apply(fake, 'c-1', workers, report, 'orkestr-v1', write=True)
        self.assertEqual(again['transitions'], [])


if __name__ == '__main__':
    unittest.main()
