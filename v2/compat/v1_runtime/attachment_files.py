"""Local attachment exports; a path is advertised only after custody checks."""
import grp
import hashlib
import os
from pathlib import Path
import re
import stat
import uuid


MEDIA_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                    "image/webp": ".webp", "application/pdf": ".pdf", "text/plain": ".txt"}


def attachment_export_settings(environ=os.environ):
    """The publisher derives EXECUTOR_GID from the selected runtime profile.

    This value is an access requirement, not new execution authority. A stale
    legacy group must not silently produce files the selected reader cannot open.
    Existing installations without that declaration retain their configured group.
    """
    directory = environ.get("ORKESTR_V2_ADAPTER_ATTACHMENT_DIR", "").strip()
    if not directory or not os.path.isabs(directory):
        return None, None
    group = environ.get("ORKESTR_V2_ADAPTER_ATTACHMENT_GROUP", "").strip()
    expected = environ.get("ORKESTR_V2_ADAPTER_ATTACHMENT_EXECUTOR_GID", "").strip()
    if expected and (not re.fullmatch(r"[1-9][0-9]{0,9}", expected)
                     or int(expected) >= 2**32 - 1):
        raise ValueError("attachment_executor_group_invalid")
    try:
        gid = grp.getgrnam(group).gr_gid if group else None
    except KeyError:
        raise ValueError("attachment_export_group_unknown") from None
    if expected and gid != int(expected):
        raise ValueError("attachment_executor_group_mismatch")
    return directory, gid


def _refuse():
    raise OSError("attachment_export_custody")


def _directory(path):
    """Open each path component without following symlinks."""
    path = Path(path)
    if not path.is_absolute() or any(p in (".", "..") for p in path.parts):
        _refuse()
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=fd)
            except FileNotFoundError:
                try:
                    os.mkdir(part, 0o750, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _scope(fd, gid):
    meta = os.fstat(fd)
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o022:
        _refuse()
    if gid is not None:
        os.fchown(fd, -1, gid)
    os.fchmod(fd, 0o750)


def _verify(fd, gid, digest, size):
    meta = os.fstat(fd)
    if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1
            or meta.st_uid != os.geteuid() or stat.S_IMODE(meta.st_mode) != 0o640
            or gid is not None and meta.st_gid != gid or meta.st_size != size):
        _refuse()
    actual = hashlib.sha256()
    with os.fdopen(os.dup(fd), "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            actual.update(chunk)
    after = os.fstat(fd)
    if (meta.st_dev, meta.st_ino, meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
    ) or actual.hexdigest() != digest:
        _refuse()


def export_attachment(directory, gid, conversation, item, content):
    """Idempotent content export, with existing-file verification, never repair.

    Repairing retained files is a separate reviewed operation. An unsafe old
    target must not be replaced, followed, re-owned, or advertised as readable.
    """
    digest = item["sha256"]
    if (not re.fullmatch("[0-9a-f]{64}", digest)
            or not re.fullmatch("[0-9a-zA-Z-]{1,64}", str(conversation))):
        return None
    if hashlib.sha256(content).hexdigest() != digest:
        _refuse()
    suffix = MEDIA_EXTENSIONS.get(item["media_type"]) or "".join(
        c for c in Path(item.get("filename") or "").suffix.lower()[:8] if c.isalnum() or c == ".")
    root = _directory(directory)
    folder = None
    try:
        _scope(root, gid)
        try:
            os.mkdir(conversation, 0o750, dir_fd=root)
        except FileExistsError:
            pass
        folder = os.open(conversation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=root)
        _scope(folder, gid)
        name = digest + suffix
        try:
            target = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
        except FileNotFoundError:
            temporary = ".%s.%s.tmp" % (digest, uuid.uuid4().hex)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o640, dir_fd=folder)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(content)
                    if gid is not None:
                        os.fchown(f.fileno(), -1, gid)
                    os.fchmod(f.fileno(), 0o640)
                    f.flush(); os.fsync(f.fileno())
                os.replace(temporary, name, src_dir_fd=folder, dst_dir_fd=folder)
                os.fsync(folder)
            finally:
                try: os.unlink(temporary, dir_fd=folder)
                except FileNotFoundError: pass
            target = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
        try:
            _verify(target, gid, digest, len(content))
        finally:
            os.close(target)
        return str(Path(directory) / conversation / name)
    finally:
        if folder is not None:
            os.close(folder)
        os.close(root)
