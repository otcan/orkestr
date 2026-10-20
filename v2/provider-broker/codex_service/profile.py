"""The same selected read-only account and bounded isolation, explicit service role."""
import os
from codex_bounded.configuration import HELPERS
from codex_bounded.trust import protected
from isolation.authenticated import SelectedCodexProfile
from isolation import policy
from .contract import require


class Configuration:
    def __init__(self, package, role="deep"):
        self.package = package
        require(role in package.role_profiles, "unconfigured_role")
        self.profile = SelectedCodexProfile(package.role_profiles[role])
        self.workspace_descriptor = None
        self.workspace = self.profile.workspace
        self.issued = False
        access = package.beta.get("host_full_access")
        # Operator instance opt-in: run the pinned native directly on the host
        # with the real executor environment (V1-equivalent, host-root equivalent).
        self.host_full_access = type(access) is dict and access.get("providers", True) is True
        self.host_environment = dict(access["environment"]) if self.host_full_access else None

    def isolated_command(self):
        require(not self.issued, "isolated_command_already_issued")
        self.issued = True
        if self.host_full_access:
            return host_command(self.profile.native, self.host_environment), ()
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


def host_command(native, environment):
    """No namespace, seccomp, egress proxy or mounts: `env -i` installs exactly
    the operator's real executor environment before the pinned native."""
    require(type(environment) is dict and {"HOME", "PATH"} <= set(environment) and all(
        type(k) is str and type(v) is str and k and "=" not in k and "\0" not in k + v
        for k, v in environment.items()), "host_environment")
    return ["/usr/bin/env", "-i", *(f"{k}={v}" for k, v in sorted(environment.items())),
            str(native), "app-server", "--listen", "stdio://"]
