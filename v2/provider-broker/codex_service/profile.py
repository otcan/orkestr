"""The same selected read-only account and bounded isolation, explicit service role."""
import os
from codex_bounded.configuration import HELPERS
from codex_bounded.trust import protected
from isolation.authenticated import SelectedCodexProfile
from isolation import policy
from .contract import require


class Configuration:
    def __init__(self, package):
        self.package = package
        self.profile = SelectedCodexProfile(package.root / "profile.json")
        self.workspace_descriptor = None
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
            command[command.index("--chdir"):command.index("--chdir")] = mounts
            return command, (descriptor,)
        except BaseException:
            os.close(descriptor)
            raise
