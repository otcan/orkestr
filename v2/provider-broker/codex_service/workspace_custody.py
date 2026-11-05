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
from .workspace_environment import definition
from .workspace_acl import check as check_acl, owner as project_owner


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


def open_checked(path, owner, directory=True, executor=None, executor_gid=None, ancestry=(), selected_writers=(), writer_roots=()):
    if executor is None:executor=owner
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
            require((stat.S_ISDIR(meta.st_mode) if is_directory else
                     stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1), 'workspace_managed_custody')
            leaf=index+1==len(parts)
            current=Path('/',*parts[:index+1])
            writers=selected_writers if any(current==root or root in current.parents for root in writer_roots) else ()
            if not leaf and os.geteuid()==0 and executor!=owner:
                # Only declared private homes use Root-retained lookup FDs.
                # Ordinary ancestors must remain traversable by the executor.
                current=Path('/',*parts[:index+1])
                declared=any(meta.st_uid==home.get('uid',owner) and
                    (current==Path(home['path']) or Path(home['path']) in current.parents) for home in ancestry)
                native_private=bool(selected_writers) and any(
                    Path(home['path']) in current.parents and meta.st_uid in {0,*selected_writers}
                    for home in ancestry)
                declared=declared or native_private
                require(meta.st_uid in (0,owner) or declared,'workspace_managed_ancestor_owner')
                # Root only traverses the original sealed native source chain;
                # these ancestors are never projected or granted to executors.
                native_ancestry=bool(declared and selected_writers and not writers)
                check_acl(fd,meta.st_uid if declared else owner,executor,0 if declared else 1,
                          executor_gid=executor_gid,
                          selected_writers=selected_writers if native_ancestry else writers,
                          source_ancestry=native_ancestry)
            else:
                check_acl(fd,owner,executor,7 if leaf and directory else 1 if is_directory else 4,
                          owner_leaf=leaf and directory,executor_gid=executor_gid,selected_writers=writers)
        result = fd; fd = None
        return result
    finally:
        if fd is not None: os.close(fd)


def small(path, owner, executor=None,executor_gid=None,ancestry=(),selected_writers=(),writer_roots=()):
    fd = open_checked(path, owner, False,executor,executor_gid,ancestry,selected_writers,writer_roots)
    try:
        raw = os.read(fd, 8193)
        require(len(raw) <= 8192, 'workspace_git_pointer_bound')
        return raw.decode('utf-8', 'strict').rstrip('\r\n')
    finally: os.close(fd)


def association(workspace, owner, executor=None,executor_gid=None,ancestry=(),selected_writers=(),writer_roots=()):
    dot = workspace / '.git'
    if selected_writers:writer_roots=(*writer_roots,workspace)
    # Even the preliminary kind check is relative to a checked retained FD;
    # open_checked below independently refuses replacement/ancestor aliases.
    fd = open_checked(workspace, owner,executor=executor,executor_gid=executor_gid,ancestry=ancestry,selected_writers=selected_writers,writer_roots=writer_roots)
    try: meta = os.stat('.git', dir_fd=fd, follow_symlinks=False)
    finally: os.close(fd)
    require(not stat.S_ISLNK(meta.st_mode), 'workspace_git_alias')
    if stat.S_ISDIR(meta.st_mode): git = dot
    else:
        text = small(dot, owner,executor,executor_gid,ancestry,selected_writers,writer_roots)
        require(text.startswith('gitdir: '), 'workspace_git_pointer')
        git = normalized(workspace, text[8:])
    if selected_writers:writer_roots=(*writer_roots,git)
    try: common = normalized(git, small(git / 'commondir', owner,executor,executor_gid,ancestry,selected_writers,writer_roots))
    except FileNotFoundError: common = git
    return git, common


class Installation:
    """Retained Root-issued handles, never a JSON-reconstructed grant."""
    def __init__(self, package, profile):
        require(os.geteuid() == 0 and package.identity_split, 'workspace_root_split')
        require(type(profile) is dict and type(profile.get('trusted')) is dict and
                type(profile['trusted'].get('managed_executor')) is dict and
                profile['trusted'].get('host_privileged', False) is False and
                profile['trusted'].get('environment', {}) == {} and
                profile['trusted'].get('credential_env_files', []) == [], 'workspace_explicit_managed_executor')
        definition(profile['trusted']['managed_executor'])
        identifier(profile['conversation_id']); identifier(profile['project_id'])
        self.executor = package.executor_uid
        self.executor_gid=getattr(package,'executor_gid',self.executor)
        self.owner = project_owner(profile,self.executor)
        require(self.owner != getattr(package,'authority_uid',None),'workspace_project_authority_owner')
        self.workspace = canonical(profile['workspace'])
        require(profile['allowed_roots'] == [str(self.workspace)], 'workspace_exact_root')
        self.protected = [canonical(str(package.home)), canonical(str(package.ledger_directory)),
                          canonical(str(package.provider_home)), canonical(str(package.root))]
        bootstrap = getattr(package, 'runtime', {}).get('bootstrap_file')
        if bootstrap is not None: self.protected.append(canonical(bootstrap))
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
        self.credential_protected = tuple(self.protected)
        self.protected.extend([*[canonical(p) for p in profile['protected_roots']],
                               canonical(profile['cgroup_root']), canonical(profile['toolchain_root'])])
        self.paths = (self.workspace, *association(self.workspace, self.owner,self.executor,self.executor_gid))
        for path in self.paths:
            require(all(path != other and path not in other.parents and other not in path.parents
                        for other in self.protected), 'workspace_managed_overlap')
        self.fds = []
        try:
            for path in self.paths:self.fds.append(open_checked(path,self.owner,executor=self.executor,executor_gid=self.executor_gid))
            self.identities = tuple(identity(fd) for fd in self.fds)
            self.check()
        except BaseException:
            self.close(); raise

    def check(self):
        require(len(self.fds) == 3, 'workspace_installation_closed')
        require((self.workspace, *association(self.workspace, self.owner,self.executor,self.executor_gid)) == self.paths,
                'workspace_git_association_changed')
        for index, path in enumerate(self.paths):
            fd = open_checked(path,self.owner,executor=self.executor,executor_gid=self.executor_gid)
            try:
                require(identity(fd) == self.identities[index] == identity(self.fds[index]),
                        'workspace_managed_replaced')
            finally: os.close(fd)

    def close(self):
        for fd in self.fds: os.close(fd)
        self.fds = []
