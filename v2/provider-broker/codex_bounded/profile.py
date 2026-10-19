"""One-use fixed bounded command; the existing profile keeps its old semantics."""
import os
from .configuration import HELPERS, Package
from .trust import protected, require
from isolation.authenticated import SelectedCodexProfile
from isolation import policy


class Configuration:
    def __init__(self, package, role=None):
        self.package = Package(package)
        self.profile = SelectedCodexProfile(self.package.profile_path(role))
        self.workspace = self.profile.workspace
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
            return command, (descriptor,)
        except BaseException:
            os.close(descriptor)
            raise
