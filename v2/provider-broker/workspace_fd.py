"""Closed inherited-workspace descriptor primitive; no path authority constructor.

Trusted Runtime supplies FD5 from Core's callback, never browser JSON. This module
cannot establish Core issuance; caller must retain its existing durable fences.
"""
import os
import stat
from dataclasses import dataclass

class WorkspaceRefused(Exception):
    pass

@dataclass(frozen=True)
class _Identity:
    device: int
    inode: int
    uid: int

class InheritedWorkspace:
    __slots__ = ('_identity',)

    def __init__(self):
        self._identity = self._inspect()

    @staticmethod
    def _inspect():
        try:
            value = os.fstat(5)
        except OSError:
            raise WorkspaceRefused('workspace_descriptor_missing') from None
        if not stat.S_ISDIR(value.st_mode):
            raise WorkspaceRefused('workspace_descriptor_not_directory')
        return _Identity(value.st_dev, value.st_ino, value.st_uid)

    def validate(self):
        if self._inspect() != self._identity:
            raise WorkspaceRefused('workspace_descriptor_changed')

    def mount_arguments(self, bubblewrap_help):
        """Help must come from the already pinned trusted bwrap executable.

        No caller-selected target, host path, proc fallback or preservation option.
        Existing profile supplies namespace/root/egress policy separately.
        """
        self.validate()
        if not isinstance(bubblewrap_help, bytes) or b'--ro-bind-fd FD DEST' not in bubblewrap_help:
            raise WorkspaceRefused('workspace_fd_mount_unsupported')
        return ('--ro-bind-fd', '5', '/workspace', '--chdir', '/workspace')

    def pass_fds(self, *, resume=False):
        """Trusted fixed launcher retains writer3, optional resume4 and workspace5."""
        if type(resume) is not bool:
            raise WorkspaceRefused('invalid_launcher_mode')
        self.validate()
        return (3, 4, 5) if resume else (3, 5)
