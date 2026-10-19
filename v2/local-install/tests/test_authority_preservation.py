import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from authority_preservation import database_inventory


class InventoryTests(unittest.TestCase):
    def test_unknown_columns_blobs_and_duplicates_are_compared_without_payload_output(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'fixture.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE history(id INTEGER, unknown BLOB, note TEXT)')
                db.executemany('INSERT INTO history VALUES (?,?,?)', [(1,b'opaque','synthetic payload')]*2)
            before=database_inventory(path)
            self.assertEqual(before['tables']['history']['rows'],2)
            self.assertNotIn('synthetic payload',json.dumps(before))
            with sqlite3.connect(path) as db:db.execute('DELETE FROM history WHERE rowid=1')
            self.assertNotEqual(before,database_inventory(path))

    def test_foreign_key_violation_refused(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'fixture.sqlite3'
            with sqlite3.connect(path) as db:
                db.executescript('CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(id REFERENCES parent(id)); INSERT INTO child VALUES (1);')
            with self.assertRaisesRegex(RuntimeError,'foreign key'):
                database_inventory(path)
