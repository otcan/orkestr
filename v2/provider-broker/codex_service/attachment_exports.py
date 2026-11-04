"""Optional sealed external export root. Metadata only; never inspect Core.

The authority owns the directory. A shared execution group receives directory
traversal and file read access only when the authenticated publisher grants it.
"""
import stat
import os
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


def initialize_conversation(package, conversation_id):
    """Root-manager setup for the authenticated launch's conversation only."""
    root = getattr(package, 'attachment_export_dir', None)
    if root is None:
        return
    from .contract import identifier
    require(os.geteuid() == 0 and package.identity_split, 'attachment_export_root_manager')
    identifier(conversation_id)
    bind(str(root), package.authority_uid, package.gid, [])
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        # Anchor each step; never reopen through a mutable path or follow a link.
        for component in root.parts[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=descriptor)
            meta = os.fstat(child)
            if meta.st_uid not in (0, package.authority_uid) or meta.st_mode & 0o022:
                os.close(child); require(False, 'attachment_export_ancestor')
            os.close(descriptor); descriptor = child
        meta = os.fstat(descriptor)
        require(meta.st_uid == package.authority_uid and meta.st_gid == package.gid
                and stat.S_IMODE(meta.st_mode) in (0o700, 0o750), 'attachment_export_custody')
        created = False
        try:
            os.mkdir(conversation_id, 0o700, dir_fd=descriptor); created = True
        except FileExistsError:
            pass
        child = os.open(conversation_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=descriptor)
        try:
            meta = os.fstat(child)
            if created:
                require(meta.st_uid == 0 and stat.S_IMODE(meta.st_mode) == 0o700,
                        'attachment_export_new_scope')
                os.fchown(child, package.authority_uid, package.gid)
            else:
                require(meta.st_uid == package.authority_uid and meta.st_gid == package.gid
                        and stat.S_IMODE(meta.st_mode) in (0o700, 0o750), 'attachment_export_scope')
            os.fchmod(child, 0o750); os.fsync(child)
            os.fchmod(descriptor, 0o750); os.fsync(descriptor)
        finally:
            os.close(child)
    finally:
        os.close(descriptor)


def conversation_mount(package, role):
    root = getattr(package, 'attachment_export_dir', None)
    if root is None or not getattr(package, 'identity_split', False):
        return None
    from .identity import launch_context
    from .contract import identifier
    context = launch_context()
    require(context is not None and context['owner_id'] == package.owner
            and context['role'] == role, 'attachment_export_launch_context')
    conversation = identifier(context['conversation_id'])
    path = bind(str(root / conversation), package.authority_uid, package.gid, [])
    require(stat.S_IMODE(path.lstat().st_mode) == 0o750, 'attachment_export_scope_not_initialized')
    return path
