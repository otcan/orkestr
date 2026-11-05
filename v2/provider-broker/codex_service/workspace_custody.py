"""Root-only exact project/Git custody for explicit managed command profiles.

Core may retain these three directory FDs without traversing executor-private
ancestors. Every later use requires a fresh Root check; paths/UUIDs from a
native, browser or command never select an installation.
"""
import os
from pathlib import Path
import stat

from .contract import require, identifier
from codex_bounded.trust import metadata


def canonical(raw):
    require(type(raw) is str and raw.startswith('/') and raw != '/' and len(raw) <= 4096
            and '\0' not in raw and all(v not in ('', '.', '..') for v in raw.split('/')[1:]),
            'workspace_managed_path')
    return Path(raw)


def normalized(base, relative):
    require(type(relative) is str and relative and '\0' not in relative and len(relative) <= 4096,
            'workspace_git_pointer')
    # Git's own relative .git/commondir format can legitimately contain '..'.
    # Normalize lexically, then reopen every component without following links.
    return canonical(os.path.normpath(str(base / relative)))


def identity(fd):
    meta = os.fstat(fd)
    return (meta.st_dev, meta.st_ino, meta.st_uid)


def open_checked(path, executor, directory=True):
    path = canonical(str(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        parts = path.parts[1:]
        for index, part in enumerate(parts):
            is_directory = index + 1 < len(parts) or directory
            child = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK |
                            (os.O_DIRECTORY if is_directory else 0), dir_fd=fd)
            os.close(fd); fd = child
            meta = os.fstat(fd)
            require(meta.st_uid in (0, executor) and meta.st_mode & 0o022 == 0 and
                    (stat.S_ISDIR(meta.st_mode) if is_directory else
                     stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1), 'workspace_managed_custody')
        require(not directory or os.fstat(fd).st_uid == executor, 'workspace_managed_owner')
        result = fd; fd = None
        return result
    finally:
        if fd is not None: os.close(fd)


def small(path, executor):
    fd = open_checked(path, executor, False)
    try:
        raw = os.read(fd, 8193)
        require(len(raw) <= 8192, 'workspace_git_pointer_bound')
        return raw.decode('utf-8', 'strict').rstrip('\r\n')
    finally: os.close(fd)


def association(workspace, executor):
    dot = workspace / '.git'
    # Even the preliminary kind check is relative to a checked retained FD;
    # open_checked below independently refuses replacement/ancestor aliases.
    fd = open_checked(workspace, executor)
    try: meta = os.stat('.git', dir_fd=fd, follow_symlinks=False)
    finally: os.close(fd)
    require(not stat.S_ISLNK(meta.st_mode), 'workspace_git_alias')
    if stat.S_ISDIR(meta.st_mode): git = dot
    else:
        text = small(dot, executor)
        require(text.startswith('gitdir: '), 'workspace_git_pointer')
        git = normalized(workspace, text[8:])
    try: common = normalized(git, small(git / 'commondir', executor))
    except FileNotFoundError: common = git
    return git, common


class Installation:
    """Retained Root-issued handles, never a JSON-reconstructed grant."""
    def __init__(self, package, profile):
        require(os.geteuid() == 0 and package.identity_split, 'workspace_root_split')
        require(type(profile) is dict and type(profile.get('trusted')) is dict and
                profile['trusted'].get('managed_executor') is True and
                profile['trusted'].get('host_privileged', False) is False, 'workspace_explicit_managed_executor')
        identifier(profile['conversation_id']); identifier(profile['project_id'])
        self.executor = package.executor_uid
        self.workspace = canonical(profile['workspace'])
        require(profile['allowed_roots'] == [str(self.workspace)], 'workspace_exact_root')
        self.protected = [canonical(str(package.home)), canonical(str(package.ledger_directory)),
                          canonical(str(package.provider_home)), canonical(str(package.root)),
                          *[canonical(p) for p in profile['protected_roots']],
                          canonical(profile['cgroup_root']), canonical(profile['toolchain_root'])]
        # Account/native-state roots may be outside provider_home. A project
        # cannot redirect its mutable Git pointer into any such installation.
        for selected in getattr(package, 'role_profiles', {}).values():
            value = metadata(selected, 32768)
            self.protected.extend(canonical(value[k]) for k in ('state_root', 'auth_file', 'workspace'))
        host = getattr(package, 'beta', {}).get('managed_host')
        if host is not None:
            environment = host['environment']
            account = environment.get('CODEX_HOME', str(Path(environment['HOME']) / '.codex'))
            self.protected.append(canonical(account))
            self.protected.extend(canonical(path) for path in host.get('environment_files', []))
        if getattr(package, 'claude', None) is not None:
            claude = metadata(package.root / 'claude-private.json', 32768)
            self.protected.extend(canonical(claude[k]) for k in ('account', 'home', 'temporary', 'workspace'))
        self.paths = (self.workspace, *association(self.workspace, self.executor))
        for path in self.paths:
            require(all(path != other and path not in other.parents and other not in path.parents
                        for other in self.protected), 'workspace_managed_overlap')
        self.fds = []
        try:
            for path in self.paths: self.fds.append(open_checked(path, self.executor))
            self.identities = tuple(identity(fd) for fd in self.fds)
            self.check()
        except BaseException:
            self.close(); raise

    def check(self):
        require(len(self.fds) == 3, 'workspace_installation_closed')
        require((self.workspace, *association(self.workspace, self.executor)) == self.paths,
                'workspace_git_association_changed')
        for index, path in enumerate(self.paths):
            fd = open_checked(path, self.executor)
            try:
                require(identity(fd) == self.identities[index] == identity(self.fds[index]),
                        'workspace_managed_replaced')
            finally: os.close(fd)

    def close(self):
        for fd in self.fds: os.close(fd)
        self.fds = []
