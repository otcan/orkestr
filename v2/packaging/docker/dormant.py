"""Offline same-image SQLite recovery; caller must stop the owned server first.

Run only in an isolated helper with network=none, using owned Docker volumes.
No schema rewrite, auth rebinding, activation or cross-version migration exists.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private(path):
    require(path.is_dir() and not path.is_symlink() and path.stat().st_uid == os.getuid()
            and stat.S_IMODE(path.stat().st_mode) == 0o700, "private owned directory required")


def regular(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1,
            "regular unaliased file required")


def integrity(database):
    require(database.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity failed')
    require(not database.execute('PRAGMA foreign_key_check').fetchall(), 'SQLite foreign key check failed')


def write(path, value):
    with open(path, 'x', opener=lambda p, flags: os.open(p, flags | os.O_NOFOLLOW, 0o600)) as stream:
        json.dump(value, stream, sort_keys=True)


def snapshot(database, output, image_manifest):
    """SQLite backup API includes WAL; caller guarantees stopped source ownership."""
    regular(database)
    regular(image_manifest)
    require(not output.exists() and not output.is_symlink(), 'fresh snapshot directory required')
    output.mkdir(mode=0o700)
    target = output / 'core.sqlite3'
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(target)) as destination:
            target.chmod(0o600)
            deadline = time.monotonic() + 30
            def progress(*_):
                require(time.monotonic() < deadline, "SQLite backup deadline exceeded")
            source.backup(destination, pages=256, progress=progress, sleep=0.05)
            destination.execute('PRAGMA journal_mode=DELETE')
            integrity(destination)
    write(output / 'manifest.json', {'format': 'orkestr-v2-container-dormant-v1',
                                    'image_manifest_sha256': digest(image_manifest),
                                    'database_sha256': digest(target),
                                    'auth': 'opaque database auth retained; bootstrap excluded',
                                    'activation': 'unsupported; rollback only'})
    return digest(target)


def apply(snapshot_root, state, image_manifest):
    private(snapshot_root)
    private(state)
    regular(snapshot_root / 'manifest.json')
    regular(snapshot_root / 'core.sqlite3')
    regular(image_manifest)
    manifest = json.loads((snapshot_root / 'manifest.json').read_text())
    require(manifest.get('format') == 'orkestr-v2-container-dormant-v1', 'snapshot format mismatch')
    require(manifest['image_manifest_sha256'] == digest(image_manifest), 'same exact image required')
    require(set(p.name for p in snapshot_root.iterdir()) == {'manifest.json', 'core.sqlite3'},
            'unexpected snapshot files')
    require(digest(snapshot_root / 'core.sqlite3') == manifest['database_sha256'], 'snapshot checksum mismatch')
    require(not any(state.iterdir()), 'fresh empty state required')
    # Receipt first: even interrupted copying must never permit server startup.
    write(state / 'restore-dormant.json', manifest)
    stage = state / '.restore-stage'
    try:
        shutil.copyfile(snapshot_root / 'core.sqlite3', stage)
        stage.chmod(0o600)
        require(digest(stage) == manifest['database_sha256'], 'copied database checksum mismatch')
        with closing(sqlite3.connect(stage.as_uri() + '?mode=ro&immutable=1', uri=True)) as database:
            integrity(database)
        (state / 'data').mkdir(mode=0o700)
        os.replace(stage, state / 'data/core.sqlite3')
    finally:
        if stage.exists():
            stage.unlink()


def rollback(state, image_manifest):
    private(state)
    regular(state / 'restore-dormant.json')
    regular(image_manifest)
    receipt = json.loads((state / 'restore-dormant.json').read_text())
    require(receipt.get('format') == 'orkestr-v2-container-dormant-v1' and
            receipt['image_manifest_sha256'] == digest(image_manifest), 'same-image receipt required')
    require(set(p.name for p in state.iterdir()) <= {'restore-dormant.json', 'data'}, 'unexpected state files')
    data = state / 'data'
    if data.exists() or data.is_symlink():
        private(data)
        require(set(p.name for p in data.iterdir()) <= {'core.sqlite3'}, 'unexpected data files')
        database = data / 'core.sqlite3'
        if database.exists() or database.is_symlink():
            regular(database)
            require(digest(database) == receipt['database_sha256'], 'database changed; rollback refused')
            database.unlink()
        data.rmdir()
    (state / 'restore-dormant.json').unlink()
