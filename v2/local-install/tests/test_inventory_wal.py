"""Committed WAL pages must participate in stopped-package comparisons."""
from pathlib import Path
import hashlib
import shutil
import sqlite3
import tempfile
import unittest

from authority_preservation import database_inventory
from genuine40_package import connect


class InventoryWalTests(unittest.TestCase):
    def test_retained_committed_wal_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch);live=root/'live.sqlite3';copy=root/'stopped.sqlite3'
            writer=sqlite3.connect(live)
            try:
                writer.execute('CREATE TABLE history(id INTEGER PRIMARY KEY)');writer.commit()
                writer.execute('PRAGMA journal_mode=WAL')
                writer.execute('PRAGMA wal_autocheckpoint=0')
                writer.execute('INSERT INTO history VALUES(1)');writer.commit()
                for suffix in ('','-wal','-shm'):
                    shutil.copyfile(str(live)+suffix,str(copy)+suffix)
                digest=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
                before={suffix:digest(Path(str(copy)+suffix)) for suffix in ('','-wal')}
                with sqlite3.connect(copy.as_uri()+'?mode=ro&immutable=1',uri=True) as main_only:
                    self.assertEqual(main_only.execute('SELECT count(*) FROM history').fetchone()[0],0)
                with connect(copy) as wal_aware:
                    self.assertEqual(wal_aware.execute('SELECT count(*) FROM history').fetchone()[0],1)
                result=database_inventory(copy)
                self.assertEqual(result['tables']['history']['rows'],1)
                self.assertEqual(before,{suffix:digest(Path(str(copy)+suffix)) for suffix in ('','-wal')})
            finally:writer.close()

    def test_standalone_snapshot_remains_supported(self):
        with tempfile.TemporaryDirectory() as scratch:
            path=Path(scratch)/'snapshot.sqlite3'
            with sqlite3.connect(path) as db:db.execute('CREATE TABLE history(id INTEGER)')
            self.assertEqual(database_inventory(path)['tables']['history']['rows'],0)
