"""Atomic Root-only record publication port for reviewed operator finalizers.

This is not an API and does not manufacture workflow proofs. The operator's
private finalizer must obtain the required typed envelopes from qualified
receipts and the exact sealed production package before calling publish().
"""
import copy
import os
from pathlib import Path
import uuid

from codex_bounded.trust import protected
from .contract import require
from .qualification import Gate, FORMAT, check_path, encoded, instance_subject, read


def publish(package, phase, evidence):
    require(os.geteuid() == 0 and package.identity_split, 'qualification_publisher_root')
    package.verify_inventory()
    path = check_path(package.runtime.get('qualification_record'), package.home, package.root)
    protected(path.parent, True)
    if path.exists() or path.is_symlink():
        read(path, 65536)  # Never replace aliases or unprotected existing state.
    value = dict(format=FORMAT, phase=phase, subject=instance_subject(package), evidence=evidence)
    temporary = path.parent / ('.qualification-' + str(uuid.uuid4()) + '.json')
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400)
        try:
            blob = encoded(value)
            require(len(blob) <= 65536, 'qualification_publication_bound')
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(blob);stream.flush();os.fsync(fd)
        finally:
            os.close(fd)
        candidate = copy.copy(package)
        candidate.runtime = {**package.runtime, 'qualification_record': str(temporary)}
        gate = Gate(candidate, allow_boot_hold=False)  # Exact evidence, custody, production and Root hold.
        os.replace(temporary.name, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
        return gate.record_hash
    finally:
        try:os.unlink(temporary.name, dir_fd=directory)
        except FileNotFoundError:pass
        os.close(directory)
