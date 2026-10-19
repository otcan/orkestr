"""An explicit immutable package, never configuration from a browser request."""
from pathlib import Path
import re
import stat
import uuid
from .trust import digest, metadata, private, protected, require

HOSTS = ("chatgpt.com",)
HELPERS = ("bounded_budget.py", "bounded_io.py", "bounded_pool.py", "bounded_dns.py", "bounded_proxy.py")
ISOLATION = ("__init__.py", "policy.py", "launch.py", "authenticated.py",
             "authenticated_budget.py", "supervisor.py", "workspace_fd.py", *HELPERS)
BROKER = ("configuration.py", "protocol.py", "transport.py", "reaping.py", "codex_bootstrap.py")
MODULES = ("__init__.py", "trust.py", "configuration.py", "profile.py", "broker.py",
           "peer.py", "egress.py", "controller.py", "server_child.py")
ROLES = ("deep", "fast")
ROLE_MODULES = (*MODULES, "roles.py")
FILES = {"server", "native", "launcher.py", "controller.py", "runtime.json", "profile.json"}
FILES |= {"broker/" + name for name in BROKER}
FILES |= {"isolation/" + name for name in ISOLATION}
FILES |= {"codex_bounded/" + name for name in MODULES}
ROLE_FILES = (FILES - {"launcher.py", "profile.json"}) | {"codex_bounded/roles.py"}
ROLE_FILES |= {f"{kind}-{role}.{suffix}" for role in ROLES
               for kind, suffix in (("launcher", "py"), ("profile", "json"))}


class Package:
    def __init__(self, root, expected=None, *, workspace_descriptor=None):
        self.root = protected(root, True)
        manifest_path = protected(self.root / "manifest.json")
        if expected is not None:
            require(digest(manifest_path) == expected, "manifest_pin")
        manifest = metadata(manifest_path)
        require(set(manifest) == {"format", "source_commit", "files", "dependencies"} and
                manifest["format"] in ("orkestr-v2-codex-bounded-package-v1",
                                       "orkestr-v2-codex-bounded-roles-package-v1") and
                re.fullmatch(r"[0-9a-f]{40}", manifest["source_commit"]), "package_format")
        self.two_roles = manifest["format"] == "orkestr-v2-codex-bounded-roles-package-v1"
        files = ROLE_FILES if self.two_roles else FILES
        require(set(manifest["files"]) == files, "package_inventory")
        actual = set()
        for path in self.root.rglob("*"):
            require(not path.is_symlink(), "package_alias")
            protected(path, path.is_dir())
            if path.is_file():
                actual.add(str(path.relative_to(self.root)))
        require(actual == files | {"manifest.json"}, "unexpected_package_file")
        for name, sha in manifest["files"].items():
            require(digest(protected(self.root / name)) == sha, "package_hash")
        dependencies = {str(Path(p).resolve(strict=True)) for p in (
            "/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/prlimit",
            "/etc/ssl/certs/ca-certificates.crt")}
        require(set(manifest["dependencies"]) == dependencies, "dependency_inventory")
        for name, sha in manifest["dependencies"].items():
            require(digest(protected(name)) == sha, "dependency_hash")
        self.manifest = manifest
        self.runtime = metadata(self.root / "runtime.json")
        if self.two_roles:
            require(workspace_descriptor is None, "workspace_roles_not_supported")
            from .roles import bind
            bind(self)
        else:
            self.profile = metadata(self.root / "profile.json")
            self._bindings(workspace_descriptor)

    def profile_path(self, role=None):
        if self.two_roles:
            require(role in ROLES, "fixed_launcher_role_required")
            return self.root / f"profile-{role}.json"
        require(role is None, "single_deep_role_unchanged")
        return self.root / "profile.json"


    def _bindings(self, workspace_descriptor=None):
        value = self.runtime
        require(set(value) == {"format", "uid", "gid", "home", "execution_config",
                "execution_config_sha256", "bootstrap_file", "port", "lifetime_seconds"} and
                value["format"] == "orkestr-v2-codex-bounded-runtime-v1", "runtime_format")
        require(all(type(value[k]) is int and 0 < value[k] < 2**31 for k in ("uid", "gid")), "runtime_identity")
        require(type(value["port"]) is int and 1024 <= value["port"] <= 65535, "loopback_port")
        require(type(value["lifetime_seconds"]) is int and 1 <= value["lifetime_seconds"] <= 900,
                "finite_controller_lifetime")
        self.uid, self.gid = value["uid"], value["gid"]
        self.home = private(value["home"], self.uid, True)
        self.data = private(self.home / "data", self.uid, True)
        self.provider_home = private(self.home / "provider-home", self.uid, True)
        private(value["bootstrap_file"], self.uid)  # Only the dropped-UID server shim reads it.
        config_path = private(value["execution_config"], self.uid)
        require(digest(config_path) == value["execution_config_sha256"], "execution_config_pin")
        self.execution = metadata(config_path, 16384)
        execution = self.execution
        required = {"schema_version", "mode", "conversation_id", "machine_token_file", "launcher",
                    "launcher_sha256", "workspace", "namespace", "supervisor_key"}
        require(required <= set(execution) <= required | {"provider", "role", "execution_budget", "workspace_authority"},
                "execution_fields")
        require(execution["schema_version"] == 1 and execution["mode"] == "isolated-acceptance-v1" and
                execution.get("provider", "codex") == "codex" and execution.get("role", "deep") == "deep",
                "selected_codex_deep_only")
        # Operator configuration is not a descriptor/grant issuer. Core validates
        # roots and current generation; only the closed descriptor entry uses FD5.
        authority = execution.get("workspace_authority")
        if authority is not None:
            require(type(authority) is dict and set(authority) ==
                    {"project_id", "allowed_roots", "protected_roots"}, "workspace_authority_fields")
            try:
                project = uuid.UUID(authority["project_id"])
                require(project.int != 0, "workspace_project")
            except (ValueError, TypeError, AttributeError):
                require(False, "workspace_project")
            for key in ("allowed_roots", "protected_roots"):
                paths = authority[key]
                require(type(paths) is list and len(paths) <= 128 and
                        (key != "allowed_roots" or len(paths) > 0), "workspace_roots")
                for path in paths:
                    require(type(path) is str and len(path.encode("utf-8")) <= 4096 and
                            Path(path).is_absolute() and not any(ord(c) < 32 for c in path) and
                            ".." not in Path(path).parts, "workspace_root_path")
        if workspace_descriptor is not None:
            require(authority is not None, "workspace_opt_in_required")
        require(execution["launcher"] == str(self.root / "launcher.py") and
                execution["launcher_sha256"] == digest(self.root / "launcher.py"), "launcher_binding")
        private(execution["machine_token_file"], self.uid)  # Metadata only; server authenticates it.
        profile = self.profile
        require(set(profile) == {"format", "native", "auth_file", "state_root", "workspace",
                "egress_socket", "supervisor", "hosts"} and
                profile["format"] == "orkestr-v2-codex-isolated-v2", "selected_profile_format")
        require(profile["native"] == str(self.root / "native") and
                profile["supervisor"] == str(self.root / "isolation/supervisor.py") and
                profile["hosts"] == list(HOSTS), "profile_artifact_binding")
        for path in (self.root / "server", self.root / "native", self.root / "launcher.py"):
            require(path.stat().st_mode & 0o111, "executable_required")
        if workspace_descriptor is None:
            workspace = private(profile["workspace"], self.uid, True)
        else:
            from isolation.workspace_fd import InheritedWorkspace, logical_workspace
            require(type(workspace_descriptor) is InheritedWorkspace,"workspace_descriptor_type")
            workspace_descriptor.validate()
            workspace = Path(logical_workspace(profile["workspace"]))
        account = private(profile["state_root"], self.uid, True)
        auth = private(profile["auth_file"], self.uid)
        require(auth.name == "auth.json", "canonical_auth_reference")
        require(str(workspace) == execution["workspace"], "workspace_binding")
        for a, b in ((workspace, self.home), (account, self.home), (workspace, account),
                     (auth, workspace), (auth, account), (auth, self.home)):
            require(a != b and a not in b.parents and b not in a.parents, "state_scope_overlap")
        self.endpoint = Path(profile["egress_socket"])
        require(self.endpoint.is_absolute() and len(bytes(self.endpoint)) < 100 and
                self.endpoint.name == "egress.sock", "endpoint_path")
        protected(self.endpoint.parent, True)
        require(not self.endpoint.is_symlink(), "endpoint_alias")
        if self.endpoint.exists():
            info = self.endpoint.lstat()
            require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == self.gid and
                    stat.S_IMODE(info.st_mode) == 0o660, "endpoint_identity")

    def environment(self):
        value = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(self.provider_home),
                 "ORKESTR_V2_HOME": str(self.data), "ORKESTR_V2_BIND": f"127.0.0.1:{self.runtime['port']}"}
        key = "ORKESTR_V2_EXECUTION_SET" if self.two_roles else "ORKESTR_V2_EXECUTION_CONFIG"
        value[key] = self.runtime["execution_set" if self.two_roles else "execution_config"]
        return value
