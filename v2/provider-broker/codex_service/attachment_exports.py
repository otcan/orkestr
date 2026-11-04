"""Optional sealed external export root. Metadata only; never inspect Core.

The authority owns the directory. A shared execution group receives directory
traversal and file read access only when the authenticated publisher grants it.
"""
import stat
from pathlib import Path
from .contract import require

ENVIRONMENT = 'ORKESTR_V2_ATTACHMENT_EXPORT_DIR'


def shape(value):
    require(type(value) is str and value.startswith('/') and 1 < len(value) <= 4096
            and '\0' not in value and not any(ord(c) < 32 for c in value)
            and all(part not in ('', '.', '..') for part in value.split('/')[1:]),
            'attachment_export_path')
    return Path(value)


def disjoint(path, forbidden):
    for other in map(Path, forbidden):
        require(path != other and path not in other.parents and other not in path.parents,
                'attachment_export_scope_overlap')


def bind(value, authority_uid, shared_gid, forbidden):
    path = shape(value)
    # Refuse overlaps before metadata lookup, including an executor role that
    # cannot stat the private Core or account home.
    disjoint(path, forbidden)
    try:
        for item in reversed((path, *path.parents)):
            meta = item.lstat()
            require(stat.S_ISDIR(meta.st_mode) and meta.st_uid in (0, authority_uid)
                    and not meta.st_mode & 0o022, 'attachment_export_ancestor')
        meta = path.lstat()
        require(meta.st_uid == authority_uid and meta.st_gid == shared_gid
                and stat.S_IMODE(meta.st_mode) in (0o700, 0o750),
                'attachment_export_custody')
    except OSError:
        require(False, 'attachment_export_metadata')
    return path
