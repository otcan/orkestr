"""Commit visibility, lost-wakeup recovery and authenticated long-poll tests."""
import json
import threading
import time
import unittest
import uuid

from v2.compat.v1_runtime.export_changes import ExportChanges
from v2.compat.v1_runtime.tests.test_ledger_server import Harness


class FeedTests(unittest.TestCase):
    def test_wait_is_not_a_poll_and_wakes_immediately(self):
        feed = ExportChanges()
        cursor = feed.read(wait_ms=0)['cursor']
        result, started = [], threading.Event()
        def waiting():
            started.set()
            result.append(feed.read(cursor, 25000))
        thread = threading.Thread(target=waiting)
        thread.start()
        self.assertTrue(started.wait(1))
        feed.publish('route-one')
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result[0]['threads'], ['route-one'])
        self.assertFalse(result[0]['reset'])

    def test_restart_future_cursor_and_disconnect_recover_snapshot(self):
        old = ExportChanges().read(wait_ms=0)['cursor']
        feed = ExportChanges()
        feed.publish('one')
        feed.publish('two')
        self.assertEqual(set(feed.read(old, 0)['threads']), {'one', 'two'})
        current = feed.read(wait_ms=0)['cursor']
        feed.publish('one')  # Happens while the client is disconnected.
        self.assertEqual(feed.read(current, 0)['threads'], ['one'])
        self.assertEqual(set(feed.read(feed.epoch + ':999', 0)['threads']), {'one', 'two'})
        self.assertTrue(feed.read(old, 0)['reset'])

    def test_shutdown_wakes_waiter(self):
        feed = ExportChanges()
        cursor = feed.read(wait_ms=0)['cursor']
        thread = threading.Thread(target=lambda: feed.read(cursor, 25000))
        thread.start()
        feed.close()
        thread.join(1)
        self.assertFalse(thread.is_alive())


class CommitTests(Harness):
    def test_export_only_wakes_after_commit_and_duplicate_never_wakes(self):
        ledger = self.binding(1).ledger
        data, _ = ledger.enqueue(self.body(), {'role': 'owner', 'id': 'owner', 'label': 'Owner'})
        feed = self.registry.changes
        cursor = feed.read(wait_ms=0)['cursor']
        message = dict(id=str(uuid.uuid4()), role='assistant', text='synthetic', parentMessageId=data['remote_id'])
        with ledger.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            ledger._export(db, data, 'final', 'final:' + data['remote_id'], message)
            self.assertEqual(feed.read(cursor, 0)['cursor'], cursor)
            with ledger.connect() as other:
                self.assertEqual(other.execute('SELECT count(*) FROM exports').fetchone()[0], 0)
        batch = feed.read(cursor, 0)
        self.assertEqual(batch['threads'], [self.remote(1)])
        self.assertEqual(len(ledger.listing(100)['messages']), 2)
        with ledger.connect() as db:
            ledger._export(db, data, 'final', 'final:' + data['remote_id'], message)
        self.assertEqual(feed.read(batch['cursor'], 0)['cursor'], batch['cursor'])

    def test_rollback_never_notifies(self):
        ledger = self.binding(1).ledger
        data, _ = ledger.enqueue(self.body(), {'role': 'owner', 'id': 'owner', 'label': 'Owner'})
        cursor = self.registry.changes.read(wait_ms=0)['cursor']
        with self.assertRaises(ValueError):
            with ledger.connect() as db:
                ledger._export(db, data, 'final', 'unique', {'id': str(uuid.uuid4())})
                raise ValueError('rollback')
        self.assertEqual(self.registry.changes.read(cursor, 0)['threads'], [])
        with ledger.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM exports').fetchone()[0], 0)

    def test_http_auth_scope_validation_and_connection_cap(self):
        status, _ = self.request('GET', '/changes?waitMs=0', token=False)
        self.assertEqual(status, 401)
        status, health = self.request('GET', '/health')
        self.assertEqual(health['messageChanges'], {'version': 1, 'path': 'changes'})
        status, snapshot = self.request('GET', '/changes?cursor=&waitMs=0')
        self.assertEqual(status, 200)
        self.assertEqual(set(snapshot['threads']), {self.remote(1), self.remote(2)})
        self.assertEqual(set(snapshot), {'ok', 'cursor', 'threads', 'reset'})
        for query in ['waitMs=-1', 'waitMs=25001', 'waitMs=1&waitMs=2', 'other=1', 'cursor=' + 'x' * 129]:
            self.assertEqual(self.request('GET', '/changes?' + query)[0], 400)
        for _ in range(16):
            self.assertTrue(self.server.change_waiters.acquire(False))
        try:
            self.assertEqual(self.request('GET', '/changes?waitMs=0')[0], 429)
            self.assertEqual(self.request('GET', '/health')[0], 200)
        finally:
            for _ in range(16):
                self.server.change_waiters.release()

    def test_http_wait_reads_export_that_arrives_after_request(self):
        cursor = self.request('GET', '/changes?waitMs=0')[1]['cursor']
        result = []
        thread = threading.Thread(target=lambda: result.append(self.request('GET', '/changes?cursor=' + cursor)))
        thread.start()
        self.post(1)
        data = self.binding(1).ledger.next_input()
        start = time.monotonic()
        self.binding(1).ledger.complete(data, dict(id=str(uuid.uuid4()), role='assistant', text='reply', parentMessageId=data['remote_id']))
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - start, 1)
        self.assertEqual(result[0][1]['threads'], [self.remote(1)])
