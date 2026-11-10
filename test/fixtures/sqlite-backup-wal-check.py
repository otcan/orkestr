"""Real SQLite WAL commits during copy; synthetic data, no application state."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile

spec = importlib.util.spec_from_file_location('snapshot', Path('scripts/backup-sqlite-snapshots.py').resolve())
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)

with tempfile.TemporaryDirectory(prefix='sqlite-backup-wal-') as scratch:
    root = Path(scratch)
    writer = sqlite3.connect(root / 'source.sqlite', timeout=.25)
    writer.execute('PRAGMA journal_mode=WAL')
    writer.execute('CREATE TABLE marker(value INTEGER)')
    writer.execute('INSERT INTO marker VALUES(0)')
    writer.execute('CREATE TABLE payload(value BLOB)')
    writer.executemany('INSERT INTO payload VALUES(?)', [(b'x' * 16384,)] * 128)
    writer.commit()
    source = sqlite3.connect((root / 'source.sqlite').as_uri() + '?mode=ro', uri=True)
    target = sqlite3.connect(root / 'target.sqlite')
    pages, writes = [], []
    def progress(_status, remaining, _total):
        pages.append(remaining)
        if remaining and len(writes) < 3:
            writer.execute('UPDATE marker SET value=value+1')
            writer.commit()  # Must succeed while the read snapshot is pinned.
            writes.append(1)
    assert snapshot.copy_snapshot(source, target, progress) is True
    assert len(writes) == 3
    assert target.execute('SELECT value FROM marker').fetchone() == (0,)
    assert writer.execute('SELECT value FROM marker').fetchone() == (3,)
    assert all(right < left for left, right in zip(pages, pages[1:])), pages
    assert target.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    assert source.in_transaction is False
    assert writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0
    target.close()
    target = sqlite3.connect(root / 'interrupted.sqlite')
    def interrupt(*_):
        raise TimeoutError('synthetic interruption')
    try:
        snapshot.copy_snapshot(source, target, interrupt)
        raise AssertionError('interruption was ignored')
    except TimeoutError:
        pass
    assert source.in_transaction is False
    assert writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0
    target.close()
    source.close()
    writer.close()
print('WAL snapshot stays consistent while writes commit; read transaction released on success and failure')
