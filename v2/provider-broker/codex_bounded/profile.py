"""One-use fixed bounded command; the existing profile keeps its old semantics."""
import os
from .configuration import HELPERS, Package
from .trust import protected, require
from isolation.authenticated import SelectedCodexProfile
from isolation import policy


class Configuration:
    def __init__(self, package, role=None, *, workspace_descriptor=None):
        self.package = Package(package, workspace_descriptor=workspace_descriptor)
        self.profile = SelectedCodexProfile(self.package.profile_path(role), workspace_descriptor=workspace_descriptor)
        self.workspace_descriptor = workspace_descriptor
        self.workspace = self.profile.workspace if workspace_descriptor is None else "/workspace"

        self.issued = False

    def isolated_command(self):
        require(not self.issued, "isolated_command_already_issued")
        self.issued = True
        descriptor = policy.filter_fd(allow_inet=True)
        try:
            command = self.profile._command(descriptor, "codex-bounded")
            mounts = []
            for name in HELPERS:
                path = protected(self.package.root / "isolation" / name)
                mounts += ["--ro-bind", str(path), "/opt/provider/" + name]
            index = command.index("--chdir")
            command[index:index] = mounts
            # Parent owns 5 until this one child is spawned; broker then closes its copy.
            return command, (descriptor,) if self.workspace_descriptor is None else (descriptor,5)
        except BaseException:
            os.close(descriptor)
            raise
