"""Proposal SQL checks only; not a schema upgrade or Store/issuer acceptance."""
import pathlib
import sqlite3
import tempfile
import unittest

SQL = (pathlib.Path(__file__).resolve().parents[1] / "crates/store-sqlite/src/history_import/timers/authority/schema-proposal.sql").read_text()


class DurableTimerSchema(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.directory.name) / "synthetic.sqlite3"
        self.db = sqlite3.connect(self.path)
        self.db.execute("PRAGMA foreign_keys=ON")
        # Minimal synthetic FK parents, explicitly not production migration credit.
        self.db.executescript("CREATE TABLE conversations(id TEXT PRIMARY KEY); CREATE TABLE dormant_timer_input_guards(owner_id TEXT,namespace TEXT,generation INTEGER,PRIMARY KEY(owner_id,namespace,generation));")
        self.db.executescript(SQL)
        self.db.execute("INSERT INTO conversations VALUES('fake-conversation')")
        self.db.execute("INSERT INTO dormant_timer_input_guards VALUES('fake-owner','fake-namespace',1)")
        self.values = ("fake-owner", "fake-namespace", 1, "fake-authority", "fake-conversation", "fake-enable", 1, "Synthetic owner task", "a" * 64, 0)
        self.db.execute("INSERT INTO durable_timer_authorities VALUES(?,?,?,?,?,?,?,?,?,?)", self.values)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def test_no_update_or_delete(self):
        for statement in ("UPDATE durable_timer_authorities SET instruction='changed'", "DELETE FROM durable_timer_authorities"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(statement)
            self.db.rollback()

    def test_reopen_retains_instruction(self):
        self.db.close()
        self.db = sqlite3.connect(self.path)
        self.assertEqual(self.db.execute("SELECT instruction FROM durable_timer_authorities").fetchone(), ("Synthetic owner task",))

    def test_unknown_generation_refuses(self):
        changed = list(self.values)
        changed[2], changed[3], changed[5] = 2, "fake-other-authority", "fake-other-key"
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO durable_timer_authorities VALUES(?,?,?,?,?,?,?,?,?,?)", changed)

    def test_no_credential_columns(self):
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(durable_timer_authorities)")}
        self.assertEqual(columns, {"owner_id", "namespace", "generation", "authority_id", "conversation_id", "request_key", "expected_revision", "instruction", "instruction_digest", "stop_sequence"})


if __name__ == "__main__":
    unittest.main()
