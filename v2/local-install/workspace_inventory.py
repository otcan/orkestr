"""Read-only operator workspace inventory. This never grants execution authority."""
import os
from pathlib import Path
import stat
import subprocess


class WorkspaceRefusal(RuntimeError):
    pass


def canonical_directory(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_dir():
        raise WorkspaceRefusal('canonical absolute directory required')
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & stat.S_IWOTH:
        raise WorkspaceRefusal('workspace must belong to operator and refuse other-writable directory')
    return path


def inspect_workspace(workspace, protected_paths):
    """Inspect a trusted operator-selected repo, without reading project files.

    No allowlist enforcement, mount-alias proof, concurrent replacement protection,
    or execution grant is supplied by this inventory. Runtime must bind authority.
    """
    workspace = canonical_directory(workspace)
    protected = [Path(p).resolve(strict=True) for p in protected_paths]
    def separate(candidate):
        if any(candidate == p or candidate in p.parents or p in candidate.parents for p in protected):
            raise WorkspaceRefusal('workspace or git metadata overlaps protected state')
    separate(workspace)
    env = {'PATH': os.defpath, 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0'}
    def git(*args):
        result = subprocess.run(['git', '-C', str(workspace), *args], env=env,
                                capture_output=True, text=True, timeout=5)
        if result.returncode:
            raise WorkspaceRefusal('local git repository inspection failed')
        return result.stdout.strip()
    root = canonical_directory(git('rev-parse', '--show-toplevel'))
    if root != workspace:
        raise WorkspaceRefusal('select repository/worktree root explicitly')
    common = canonical_directory(git('rev-parse', '--path-format=absolute', '--git-common-dir'))
    metadata = canonical_directory(git('rev-parse', '--absolute-git-dir'))
    separate(common); separate(metadata)
    head = git('rev-parse', '--verify', 'HEAD')
    if len(head) not in (40, 64) or any(c not in '0123456789abcdef' for c in head):
        raise WorkspaceRefusal('committed repository identity required')
    def anchor(p):
        info = p.stat()
        return {'device': info.st_dev, 'inode': info.st_ino}
    return {'format': 'orkestr-v2-workspace-inventory-v1', 'workspace': str(workspace),
            'git_common_directory': str(common), 'git_directory': str(metadata), 'head': head,
            'anchors': {name: anchor(p) for name, p in
                        [('workspace', workspace), ('common', common), ('metadata', metadata)]},
            'authority': 'none', 'generation_binding': 'pending-runtime-contract'}
