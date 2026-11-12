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

    def add_export(self, export_id, kind, input_id='input', outcome=None, ack=None):
        message = {'id': export_id, 'role': 'assistant', 'state': 'completed', 'parentMessageId': input_id,
                   'phase': 'commentary' if kind == 'progress' else 'final_answer', 'text': 'Synthetic ' + export_id}
        with self.ledger.connect() as db:
            db.execute('INSERT INTO exports(export_id,input_id,kind,source_key,message,outcome,ack) VALUES(?,?,?,?,?,?,?)',
                       (export_id, input_id, kind, '%s:%s:%s' % (kind, input_id, export_id), json.dumps(message), outcome, ack))

    def outcomes(self):
        with self.ledger.connect() as db:
            return dict(db.execute('SELECT export_id,outcome FROM exports').fetchall())

    def test_opt_in_supersedes_pending_progress_in_the_same_transaction(self):
        # Progress recorded before and after the final, as on a live ledger.
        self.add_export('progress-a', 'progress')
        self.add_export('progress-b', 'progress')
        with self.ledger.connect() as db:
            db.execute("UPDATE exports SET seq=seq+10 WHERE export_id='export'")
        self.add_export('progress-c', 'progress')
        # Another input's pending progress is never touched.
        with self.ledger.connect() as db:
            other = dict(self.data, remote_id='other', public_id='other-public', origin=None)
            db.execute('INSERT INTO inputs VALUES(?,?,?,?)', ('other-public', 'd3', 'other', json.dumps(other)))
        self.add_export('other-progress', 'progress', input_id='other')
        view = inspect(self.path, 'export')
        self.assertEqual([o['export_id'] for o in view['other_pending_exports']], ['progress-a', 'progress-b', 'progress-c'])
        self.assertNotIn('Synthetic', json.dumps(view))
        # Without the flag the existing refusal stands.
        self.refuse()
        receipt = suppress(self.path, 'export', **dict(self.request, supersede_pending_progress=True))
        self.assertEqual(receipt['superseded_progress_export_ids'], ['progress-a', 'progress-b', 'progress-c'])
        self.assertFalse(receipt['acknowledged'])
        self.assertFalse(receipt['send_triggered'])
        self.assertEqual(self.outcomes(), {'export': 'suppressed', 'progress-a': 'superseded', 'progress-b': 'superseded',
                                           'progress-c': 'superseded', 'other-progress': None})
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM exports WHERE ack IS NOT NULL").fetchone()[0], 0)
            texts = [json.loads(m)['text'] for (m,) in db.execute("SELECT message FROM exports WHERE input_id='input' ORDER BY seq")]
            self.assertEqual(texts, ['Synthetic progress-a', 'Synthetic progress-b', 'Synthetic full reply text', 'Synthetic progress-c'])
            audit = json.loads(db.execute('SELECT receipt_json FROM export_admin_dispositions').fetchone()[0])
            self.assertEqual(audit['superseded_progress_export_ids'], ['progress-a', 'progress-b', 'progress-c'])
        # V1 no longer lists any of them; only the other input stays pending.
        listed = [m.get('id') for m in self.ledger.listing()['messages']]
        self.assertNotIn('export', listed)
        self.assertFalse({'progress-a', 'progress-b', 'progress-c'} & set(listed))
        self.assertIn('other-progress', listed)
        # Exact replay is read-only, also after a late V1 report of a progress.
        self.ledger.acknowledge('progress-a', {'outcome': 'delivered', 'outboxJobId': 'job', 'parentPublicMessageId': 'public'})
        before = self.snapshot()
        again = suppress(self.path, 'export', **dict(self.request, supersede_pending_progress=True))
        self.assertEqual(dict(receipt, duplicate=True), again)
        self.assertEqual(before, self.snapshot())
        # The same key without the opt-in is a different decision.
        self.refuse()

    def test_opt_in_still_refuses_another_final_or_uncertain_export(self):
        for kind, outcome in (('final', None), ('final', 'uncertain'), ('progress', 'uncertain')):
            with self.subTest(kind=kind, outcome=outcome):
                with self.ledger.connect() as db:
                    db.execute("DELETE FROM exports WHERE export_id!='export'")
                self.add_export('progress-ok', 'progress')
                self.add_export('blocking', kind, outcome=outcome, ack='{}' if outcome else None)
                self.refuse(supersede_pending_progress=True)
                self.assertEqual(self.outcomes(), {'export': None, 'progress-ok': None, 'blocking': outcome})
        self.refuse(supersede_pending_progress='yes')

    def test_opt_in_rolls_back_when_a_progress_update_fails(self):
        self.add_export('progress-a', 'progress')
        self.add_export('progress-b', 'progress')
        with self.ledger.connect() as db:
            db.execute("CREATE TRIGGER synthetic_fail BEFORE UPDATE OF outcome ON exports "
                       "WHEN NEW.export_id='progress-b' BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        before = self.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            suppress(self.path, 'export', **dict(self.request, supersede_pending_progress=True))
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.outcomes(), {'export': None, 'progress-a': None, 'progress-b': None})

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
