"""Private inert plan artifact I/O and recovery. Never opens a product database."""
import fcntl
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from planner import empty_ledger, reconcile, validate_ledger
from snapshot import canonical, load, need, read_json, sha


def checked_output(path):
    path = Path(path).absolute()
    need(path.parent.is_dir(), 'output_parent_missing')
    need(path.parent.resolve() == path.parent and not path.is_symlink(), 'output_symlink')
    need(not path.exists() or path.is_file(), 'output_not_file')
    return path


def atomic_write(path, value):
    path = checked_output(path)
    fd, temporary = tempfile.mkstemp(prefix='.migration-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(value) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def locked(path):
    path = checked_output(path)
    lock_path = path.with_name(path.name + '.lock')
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield path
    finally:
        os.close(fd)


def plan_to_file(snapshot_root, destination):
    snapshot_root = Path(snapshot_root).absolute()
    need(snapshot_root.resolve() == snapshot_root, 'snapshot_root_alias')
    destination = checked_output(destination)
    need(not destination.is_relative_to(snapshot_root), 'source_output_overlap')
    document = load(snapshot_root)
    with locked(destination):
        previous = read_json(destination) if destination.exists() else empty_ledger()
        ledger, counts = reconcile(document, previous)
        # Recheck snapshot integrity before committing the derived artifact.
        need(load(snapshot_root) == document, 'source_changed')
        atomic_write(destination, ledger)
    return counts


def recovery_export(ledger_path, archive_path):
    """Recover the audit ledger only, including any V2-only delta decisions."""
    archive_path = checked_output(archive_path)
    ledger_path = Path(ledger_path).absolute()
    need(archive_path != ledger_path, 'source_output_overlap')
    with locked(archive_path):
        need(not archive_path.exists(), 'recovery_target_exists')
        with locked(ledger_path):
            ledger = validate_ledger(read_json(ledger_path))
        body = {'version': 1, 'format': 'inert-migration-ledger-recovery', 'ledger': ledger}
        atomic_write(archive_path, {**body, 'digest': sha(body)})


def recovery_restore(archive_path, destination):
    """Fresh ledger only. This cannot restore Core, auth or provider state."""
    archive = read_json(Path(archive_path))
    need(set(archive) == {'version', 'format', 'ledger', 'digest'}, 'recovery_fields')
    need(archive['version'] == 1 and archive['format'] == 'inert-migration-ledger-recovery',
         'recovery_version')
    need(archive['digest'] == sha({k: v for k, v in archive.items() if k != 'digest'}),
         'recovery_digest')
    ledger = validate_ledger(archive['ledger'])
    with locked(destination) as path:
        need(not path.exists(), 'restore_target_exists')
        atomic_write(path, ledger)
