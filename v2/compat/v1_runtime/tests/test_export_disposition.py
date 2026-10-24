"""Synthetic local ledgers only. No runtime, WhatsApp or provider peer."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.export_disposition import Refused, inspect, suppress


class ExportDispositionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'ledger.sqlite3'
        self.ledger = Ledger(self.path, {'conversation': 'synthetic', 'chat': 'synthetic-group'})
        self.data = {'remote_id': 'input', 'public_id': 'public', 'phase': 'completed',
                     'text': 'Synthetic full input text', 'origin': 'timer',
                     'public_thread_id': 'synthetic-thread', 'chat_id': 'synthetic-group',
                     'account_id': 'synthetic-account'}
        self.message = {'id': 'export', 'role': 'assistant', 'state': 'completed',
                        'parentMessageId': 'input', 'text': 'Synthetic full reply text'}
        with self.ledger.connect() as db:
            db.execute('INSERT INTO inputs VALUES(?,?,?,?)', ('public', 'digest', 'input', json.dumps(self.data)))
            db.execute('INSERT INTO exports(export_id,input_id,kind,source_key,message) VALUES(?,?,?,?,?)',
                       ('export', 'input', 'final', 'final:input', json.dumps(self.message)))
        view = inspect(self.path, 'export')
        self.request = dict(input_id='input', scope_sha256=view['scope_sha256'],
                            message_sha256=view['message_sha256'], request_key='synthetic:1',
                            reason='Explicit synthetic stale telemetry decision', confirm_never_transported=True)

    def snapshot(self):
        with self.ledger.connect() as db:
            return (db.execute('SELECT * FROM inputs').fetchall(),
                    db.execute('SELECT * FROM exports').fetchall(),
                    db.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall())

    def refuse(self, **changes):
        before = self.snapshot()
        with self.assertRaises(Refused):
            suppress(self.path, 'export', **dict(self.request, **changes))
        self.assertEqual(before, self.snapshot())

    def test_suppression_retains_full_text_without_ack_and_next_export_still_lists(self):
        receipt = suppress(self.path, 'export', **self.request)
        self.assertFalse(receipt['acknowledged'])
        self.assertFalse(receipt['send_triggered'])
        with self.ledger.connect() as db:
            message, outcome, ack = db.execute('SELECT message,outcome,ack FROM exports').fetchone()
            self.assertEqual(json.loads(message), self.message)
            self.assertEqual(outcome, 'suppressed')
            self.assertIsNone(ack)
            data = json.loads(db.execute('SELECT data FROM inputs').fetchone()[0])
            self.assertEqual(data['text'], self.data['text'])
            audit = db.execute('SELECT full_export_message,full_input_data FROM export_admin_dispositions').fetchone()
            self.assertEqual(json.loads(audit[0]), self.message)
            self.assertEqual(json.loads(audit[1]), self.data)
        self.assertEqual(self.ledger.listing()['messages'], [])
        self.assertEqual(self.ledger.listing()['mirrorAck']['ackedThrough'], 1)
        # An independent future input/export is still visible and can use the
        # ordinary transport ACK path; the admin command never performs it.
        with self.ledger.connect() as db:
            data = dict(self.data, remote_id='next', public_id='next-public', origin=None)
            db.execute('INSERT INTO inputs VALUES(?,?,?,?)', ('next-public', 'd2', 'next', json.dumps(data)))
        self.ledger.complete(data, dict(self.message, id='next-export', parentMessageId='next'))
        self.assertIn('next-export', [m['id'] for m in self.ledger.listing()['messages']])

    def test_idempotent_replay_is_read_only_and_different_decision_refuses(self):
        first = suppress(self.path, 'export', **self.request)
        before = self.snapshot()
        again = suppress(self.path, 'export', **self.request)
        self.assertEqual(dict(first, duplicate=True), again)
        self.assertEqual(before, self.snapshot())
        self.refuse(reason='different decision')
        self.refuse(request_key='synthetic:other')

    def test_identity_and_explicit_confirmation_guards(self):
        for changes in ({'input_id': 'foreign'}, {'scope_sha256': '0' * 64},
                        {'message_sha256': '0' * 64}, {'confirm_never_transported': False},
                        {'request_key': ''}, {'reason': ''}, {'message_sha256': None}):
            self.refuse(**changes)

    def test_recorded_or_uncertain_transport_refuses(self):
        for outcome, ack in [('delivered', '{}'), ('uncertain', '{}'), ('suppressed', None), (None, '{}')]:
            with self.ledger.connect() as db:
                db.execute('UPDATE exports SET outcome=?,ack=?', (outcome, ack))
            self.refuse()

    def test_running_input_pending_progress_and_batch_refuse(self):
        for changes in ({'phase': 'running'}, {'burst': ['other']}, {'absorbed_into': 'other'}, {'settled': {'outcome': 'failed'}}):
            with self.ledger.connect() as db:
                db.execute('UPDATE inputs SET data=?', (json.dumps(dict(self.data, **changes)),))
            self.refuse()
        with self.ledger.connect() as db:
            db.execute('UPDATE inputs SET data=?', (json.dumps(self.data),))
            db.execute("INSERT INTO exports(export_id,input_id,kind,source_key,message) VALUES('progress','input','progress','progress:input','{}')")
        self.refuse()

    def test_audit_is_immutable_and_transaction_failure_rolls_back(self):
        with self.ledger.connect() as db:
            db.execute("CREATE TRIGGER synthetic_fail BEFORE UPDATE ON inputs BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        before = self.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            suppress(self.path, 'export', **self.request)
        self.assertEqual(before, self.snapshot())
        with self.ledger.connect() as db:
            db.execute('DROP TRIGGER synthetic_fail')
        suppress(self.path, 'export', **self.request)
        for sql in ('DELETE FROM export_admin_dispositions', "UPDATE export_admin_dispositions SET reason='altered'"):
            with self.ledger.connect() as db, self.assertRaises(sqlite3.IntegrityError):
                db.execute(sql)

    def test_inspect_does_not_write_or_expose_payload_and_paths_refuse(self):
        before = self.snapshot()
        result = inspect(self.path, 'export')
        self.assertEqual(before, self.snapshot())
        self.assertNotIn('Synthetic', json.dumps(result))
        link = self.path.with_name('link.sqlite3')
        link.symlink_to(self.path)
        for path, export in [(link, 'export'), (self.path.with_name('absent'), 'export'), (self.path, 'foreign')]:
            with self.assertRaises(Refused):
                inspect(path, export)


if __name__ == '__main__':
    unittest.main()
