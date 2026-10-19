"""Disposable Git topology for the Core/Runtime workspace FD adapter.

Paths are fixture setup inputs, never serialized authority or launcher fallbacks.
No imports from selected-profile/controller helpers and no Store reimplementation.
"""
from pathlib import Path
import os
import subprocess
import tempfile


class WorkspaceVectors:
    def __init__(self):
        self._scratch = tempfile.TemporaryDirectory(prefix='v2-workspace-vectors-')
        self.root = Path(self._scratch.name).resolve()
        self.root.chmod(0o700)
        self.parent = self.root/'project'
        self.worker = self.root/'worker'
        self.foreign = self.root/'outside-allowlist'
        self.parent.mkdir(); self.foreign.mkdir()
        self.git(self.parent, 'init', '-q')
        (self.parent/'sentinel.txt').write_bytes(b'public synthetic original\n')
        self.git(self.parent, 'add', 'sentinel.txt')
        self.git(self.parent, '-c', 'user.name=Synthetic', '-c',
                 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic fixture')
        self.git(self.parent, 'worktree', 'add', '-qb', 'synthetic-worker', str(self.worker))
        (self.worker/'sentinel.txt').write_bytes(b'public synthetic dirty edit\n')
        self.common = self.parent/'.git'
        self.worker_git = Path(self.git(self.worker, 'rev-parse', '--absolute-git-dir'))

    def git(self, root, *args):
        env = {'PATH': os.defpath, 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0'}
        return subprocess.run(['git', '-C', str(root), *args], check=True, env=env,
                              capture_output=True, text=True, timeout=10).stdout.strip()

    def replace_workspace(self):
        """Call after Core selects/opens worker; retain displaced directory."""
        displaced = self.root/'displaced-worker'
        self.worker.rename(displaced)
        self.worker.mkdir()
        (self.worker/'sentinel.txt').write_bytes(b'public synthetic replacement\n')
        return displaced

    def replace_worker_metadata(self):
        """Call after selection; old descriptor must never become new pathname."""
        displaced = self.worker_git.with_name(self.worker_git.name+'-displaced')
        self.worker_git.rename(displaced)
        self.worker_git.mkdir()
        return displaced

    def close(self):
        self._scratch.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()


# Driver contract only: these names are NOT proof that authority tests ran.
FD_ADAPTER_CASES = {
    'linked-worktree': 'select parent/worker explicitly; callback borrows all three handles',
    'foreign-scope': 'outside-allowlist is same uid, excluded scope; Core refuses issuance',
    'foreign-owner': 'requires disposable different-uid fixture supplied by privileged test owner; never chown live data',
    'workspace-replaced': 'retain old FD, rename/create path, Core fence decides refusal; no string reopen',
    'metadata-replaced': 'retain old git FD, rename/create path; no string reopen',
    'revoke': 'Core revokes durable grant; Runtime must not spawn on rejected fence',
    'reopen': 'close Store; reopen, obtain new authority/handles; prior launch never reused',
    'callback-error': 'consume once before callback; retain external child for reconciliation',
    'closed-handle': 'closed/invalid FD refuses before child creation; no cwd fallback',
}
