"""Synthetic census checks; never opens deployment stores."""
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from census import count_snapshot


class CensusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "snapshot.sqlite"
        db = sqlite3.connect(self.path)
        db.executescript("CREATE TABLE runs (payload TEXT);"
                         "INSERT INTO runs VALUES ('synthetic-secret-must-not-appear');"
                         "CREATE TABLE jobs (name TEXT);")
        db.close()
        self.original = self.path.read_bytes()
        self.digest = hashlib.sha256(self.original).hexdigest()

    def count(self, **kwargs):
        args = dict(family="jobs", expected_sha256=self.digest,
                    consistency_receipt="synthetic-backup-receipt")
        args.update(kwargs)
        return count_snapshot(self.path, **args)

    def test_counts_without_contents_or_source_changes(self):
        report = self.count()
        self.assertEqual(report['counts']['runs'], dict(status='counted', count=1))
        self.assertEqual(report['counts']['jobs']['count'], 0)
        self.assertEqual(report['counts']['approvals'], dict(status='absent', count=None))
        self.assertNotIn('synthetic-secret', repr(report))
        self.assertEqual(self.original, self.path.read_bytes())
        self.assertEqual([self.path], list(self.path.parent.iterdir()))

    def test_digest_and_receipt_required(self):
        for args in ({'expected_sha256': '0' * 64}, {'consistency_receipt': ''},
                     {'family': 'credentials'}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.count(**args)

    def test_sidecars_rejected(self):
        Path(str(self.path) + '-wal').touch()
        with self.assertRaises(ValueError):
            self.count()

    def test_views_are_not_executed(self):
        db = sqlite3.connect(self.path)
        db.execute('CREATE VIEW approvals AS SELECT payload FROM runs')
        db.close()
        report = self.count(expected_sha256=hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertEqual(report['counts']['approvals'], dict(status='unsupported', count=None))

    def test_symlinks_rejected(self):
        link = self.path.parent / 'link.sqlite'
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            count_snapshot(link, family='jobs', expected_sha256=self.digest,
                           consistency_receipt='synthetic')


if __name__ == '__main__':
    unittest.main()
