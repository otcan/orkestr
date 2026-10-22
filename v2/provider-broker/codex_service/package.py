"""Closed immutable always-on package. Never inspect account credential bytes."""
from pathlib import Path
import re
import stat

from codex_bounded.configuration import BROKER, ISOLATION, MODULES, HOSTS
from codex_bounded.trust import digest, metadata, private, protected, system_dependency
from .contract import identifier, require

MAX_RUNTIME_WINDOWS = 64
from .role_profiles import ROLE_FILES, bind as bind_roles

MODULES_SERVICE = ("__init__.py", "contract.py", "ledger.py", "budget.py", "custody.py",
                   "channel.py", "package.py", "ownership.py", "egress.py", "manager.py",
                   "server_child.py", "broker.py", "profile.py", "entry.py", "role_profiles.py",
                   "claude_broker.py")
# Shared with the server and packager: room for many per-conversation
# command profiles.
MAX_BETA_CONFIG_BYTES = 262144
MAX_ADDITIONAL_WORKSPACE_EXEC = 128
FILES = {"server", "native", "manager.py", "launcher.py", "service.json", "profile.json", "beta.json"}
FILES |= {"broker/" + name for name in BROKER}
FILES |= {"isolation/" + name for name in ISOLATION}
FILES |= {"codex_bounded/" + name for name in MODULES}
FILES |= {"codex_service/" + name for name in MODULES_SERVICE}
# Host full access only: Codex starts its code-mode host (every dynamic tool
# call, for example orkestr_workspace_exec) from the native's own directory.
# Pinned beside the native; the sandboxed provider forbids subprocesses.
CODE_MODE_HOST = "codex-code-mode-host"
HOST_FILES = {CODE_MODE_HOST}
# Optional per-conversation Claude Deep runtime (operator host full access).
CLAUDE_BROKER = ("claude_connector.py", "claude_protocol.py", "claude_control.py",
                 "claude_telemetry.py", "claude_resume.py", "claude_bootstrap.py")
CLAUDE_FILES = {"launcher-claude.py", "claude-private.json"} | {"broker/" + name for name in CLAUDE_BROKER}
DEPENDENCIES = ("/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/prlimit",
                "/etc/ssl/certs/ca-certificates.crt")


LIVE_MAP_ENV = "ORKESTR_V2_LIVE_MAP"
# Private V1 desktop lease broker client file (0600, service user); the server
# validates and reads it, the package never does.
DESKTOP_BROKER_ENV = "ORKESTR_V2_DESKTOP_BROKER_CONFIG"
# Private durable-timer scheduler config (0600, service user; names the machine
# token file). The server validates and reads it, the package never does.
TIMER_CONFIG_ENV = "ORKESTR_V2_TIMER_CONFIG"
# Read-only V1 chat icon directory (operator-granted read access only).
V1_CHAT_ICONS_ENV = "ORKESTR_V2_V1_CHAT_ICONS_DIR"
# Private "New WhatsApp chat" file (adapter token, owner numbers); the server
# validates and reads it, the package never does.
WHATSAPP_CHATS_ENV = "ORKESTR_V2_WHATSAPP_CHATS_CONFIG"
# Local-only request metrics (Prometheus text and JSON) on the loopback port
# after the API port. The public proxy only forwards the API port; a busy
# metrics port is logged by the server and never blocks startup.
METRICS_BIND_ENV = "ORKESTR_V2_METRICS_BIND"
# One structured journal line per request (route template, status, timings).
ACCESS_LOG_ENV = "ORKESTR_V2_ACCESS_LOG"


def live_map_path(value):
    """Optional operator-selected live-map JSON. Read-only by the server; never package input."""
    require(type(value) is str and value.startswith("/") and 1 < len(value) <= 4096
            and "\0" not in value and ".." not in Path(value).parts
            and not any(ord(c) < 32 for c in value), "live_map_path")
    return value


class Package:
    def __init__(self, root, expected=None):
        self.root = protected(root, True)
        manifest_path = protected(self.root / "manifest.json")
        if expected is not None:
            require(digest(manifest_path) == expected, "manifest_pin")
        manifest = metadata(manifest_path, 1024 * 1024)
        require(set(manifest) == {"format", "source_commit", "files", "dependencies", "ui"}
                and manifest["format"] == "orkestr-v2-codex-service-package-v1"
                and type(manifest["source_commit"]) is str
                and re.fullmatch(r"[0-9a-f]{40}", manifest["source_commit"]), "package_format")
        require(type(manifest["files"]) is dict and set(manifest["files"]) - HOST_FILES in
                (FILES, FILES | ROLE_FILES, FILES | CLAUDE_FILES, FILES | ROLE_FILES | CLAUDE_FILES),
                "package_inventory")
        ui = manifest["ui"]
        require(type(ui) is dict and 0 < len(ui) <= 10000 and "index.html" in ui, "ui_inventory")
        for name in ui:
            require(type(name) is str and 0 < len(name) <= 512 and not name.startswith("/")
                    and all(part not in ("", ".", "..") for part in name.split("/"))
                    and "\\" not in name, "ui_path")
        pinned = {**manifest["files"], **{"ui/" + name: value for name, value in ui.items()}}
        actual = set()
        for path in self.root.rglob("*"):
            require(not path.is_symlink(), "package_alias")
            protected(path, path.is_dir())
            if path.is_file():
                actual.add(str(path.relative_to(self.root)))
        require(actual == set(pinned) | {"manifest.json"}, "unexpected_package_file")
        for name, value in pinned.items():
            require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value)
                    and digest(protected(self.root / name)) == value, "package_hash")
        dependencies = {str(Path(name).resolve(strict=True)) for name in DEPENDENCIES}
        require(type(manifest["dependencies"]) is dict and set(manifest["dependencies"]) == dependencies,
                "dependency_inventory")
        for name, value in manifest["dependencies"].items():
            # OS-managed: custody, never bytes (see trust.system_dependency).
            require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value), "dependency_hash")
            system_dependency(name)
        self.manifest = manifest
        self.runtime = metadata(self.root / "service.json")
        self.profile = metadata(self.root / "profile.json")
        self.beta = metadata(self.root / "beta.json", MAX_BETA_CONFIG_BYTES)
        self._bind()
        bind_roles(self)

    def _bind(self):
        value = self.runtime
        require(set(value) - {"live_map", "desktop_broker", "timer_config", "v1_chat_icons_dir", "whatsapp_chats"} == {"format", "uid", "gid", "owner_id", "conversation_id", "home",
                "bootstrap_file", "ledger_directory", "endpoint_directory", "port", "trusted_origin"}
                and value["format"] == "orkestr-v2-codex-service-v1", "service_format")
        self.live_map = live_map_path(value["live_map"]) if "live_map" in value else None
        self.desktop_broker = (live_map_path(value["desktop_broker"])
                               if "desktop_broker" in value else None)
        self.timer_config = (live_map_path(value["timer_config"])
                             if "timer_config" in value else None)
        self.v1_chat_icons_dir = (live_map_path(value["v1_chat_icons_dir"])
                                  if "v1_chat_icons_dir" in value else None)
        self.whatsapp_chats = (live_map_path(value["whatsapp_chats"])
                               if "whatsapp_chats" in value else None)
        require(all(type(value[k]) is int and 0 < value[k] < 2**31 for k in ("uid", "gid")),
                "service_identity")
        require(type(value["port"]) is int and 1024 <= value["port"] <= 65535, "service_port")
        self.owner, self.conversation = identifier(value["owner_id"]), identifier(value["conversation_id"])
        self.uid, self.gid = value["uid"], value["gid"]
        self.home = private(value["home"], self.uid, True)
        self.data = private(self.home / "data", self.uid, True)
        self.provider_home = private(self.home / "provider-home", self.uid, True)
        private(value["bootstrap_file"], self.uid)
        self.ledger_directory = protected(value["ledger_directory"], True)
        require(stat.S_IMODE(self.ledger_directory.stat().st_mode) == 0o700, "ledger_mode")
        endpoints = protected(value["endpoint_directory"], True)
        self.control = endpoints / "control.sock"
        self.endpoint = endpoints / "egress.sock"
        require(max(len(bytes(self.control)), len(bytes(self.endpoint))) < 100, "endpoint_bound")
        origin = value["trusted_origin"]
        require(type(origin) is str and (origin.startswith("https://") or
                origin == f"http://127.0.0.1:{value['port']}") and len(origin) <= 512
                and not any(ord(c) < 33 for c in origin) and not origin.endswith("/"), "trusted_origin")
        beta = self.beta
        require(set(beta) - {"roles", "workspace_exec", "additional_workspace_exec", "max_active_windows",
                             "window_max_minutes", "conversation_window_max_minutes",
                             "host_full_access", "claude", "conversation_workspaces"} == {"schema_version", "owner_id", "conversation_id", "manager_socket",
                "launcher", "launcher_sha256", "workspace", "namespace", "supervisor_key"}
                and type(beta["schema_version"]) is int and beta["schema_version"] == 1,
                "beta_format")
        require(beta["owner_id"] == self.owner and beta["conversation_id"] == self.conversation
                and beta["manager_socket"] == str(self.control)
                and beta["launcher"] == str(self.root / "launcher.py")
                and beta["launcher_sha256"] == digest(self.root / "launcher.py"), "beta_binding")
        for key in ("namespace", "supervisor_key"):
            require(type(beta[key]) is str and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", beta[key]), "beta_key")
        if "max_active_windows" in beta:
            # Runtime's owner-wide capacity; the ledger's own ceiling stays above it.
            require(type(beta["max_active_windows"]) is int
                    and 0 < beta["max_active_windows"] <= MAX_RUNTIME_WINDOWS, "beta_window_capacity")
        if "host_full_access" in beta:
            access = beta["host_full_access"]
            require(type(access) is dict and set(access) <= {"providers", "environment", "environment_files"}
                    and type(access.get("environment_files", [])) is list
                    and len(access.get("environment_files", [])) <= 8
                    and all(type(f) is str and f.startswith("/") and "\0" not in f and ".." not in Path(f).parts
                            for f in access.get("environment_files", []))
                    and type(access.get("providers", True)) is bool
                    and type(access.get("environment")) is dict
                    and {"HOME", "PATH"} <= set(access["environment"])
                    and all(type(k) is str and type(v) is str and "\0" not in k + v
                            for k, v in access["environment"].items()), "host_full_access")
        if "conversation_workspaces" in beta:
            # Per-conversation Deep/Fast working directories, host full access only.
            table = beta["conversation_workspaces"]
            require(type(table) is dict and 0 < len(table) <= 128 and "host_full_access" in beta
                    and all(type(k) is str and re.fullmatch(
                        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", k)
                        and type(v) is str and v.startswith("/") and v != "/" and "\0" not in v
                        and not v.endswith("/") and len(v) <= 4096
                        and all(part not in ("", ".", "..") for part in v.split("/")[1:])
                        for k, v in table.items()), "conversation_workspaces")
        additional = beta.get("additional_workspace_exec", [])
        # Further conversations' projects: same closed shape and the same
        # command profile kind (one tool schema for every Worker broker).
        require(type(additional) is list and len(additional) <= MAX_ADDITIONAL_WORKSPACE_EXEC
                and (not additional or "workspace_exec" in beta), "workspace_exec_config")
        for command in ([beta["workspace_exec"]] if "workspace_exec" in beta else []) + additional:
            require(type(command) is dict and set(command) - {"trusted"} == {"conversation_id",
                    "project_id", "workspace", "allowed_roots", "protected_roots", "cgroup_root",
                    "toolchain_root"} and "roles" in beta, "workspace_exec_config")
            # Runtime validates the trusted profile's fields, limits and overlaps.
            require(type(command.get("trusted", {})) is dict, "workspace_exec_trusted")
            identifier(command["conversation_id"])
            identifier(command["project_id"])
            require(type(command["workspace"]) is str and command["allowed_roots"] == [command["workspace"]]
                    and type(command["protected_roots"]) is list and command["protected_roots"],
                    "workspace_exec_roots")
            for path in [command["workspace"], command["cgroup_root"], command["toolchain_root"],
                         *command["protected_roots"]]:
                require(type(path) is str and path.startswith("/") and len(path) <= 4096
                        and "\0" not in path and ".." not in Path(path).parts,
                        "workspace_exec_path")
            require(("trusted" in command) == ("trusted" in beta["workspace_exec"]), "workspace_exec_trusted")
        scopes = [(c["conversation_id"], c["project_id"]) for c in
                  ([beta["workspace_exec"]] if "workspace_exec" in beta else []) + additional]
        require(len({c for c, _ in scopes}) == len({p for _, p in scopes}) == len(scopes), "workspace_exec_scope")
        profile = self.profile
        require(set(profile) == {"format", "native", "auth_file", "state_root", "workspace",
                "egress_socket", "supervisor", "hosts"}
                and profile["format"] == "orkestr-v2-codex-isolated-v2", "selected_profile_format")
        require(profile["native"] == str(self.root / "native") and
                profile["supervisor"] == str(self.root / "isolation/supervisor.py") and
                profile["hosts"] == list(HOSTS) and profile["egress_socket"] == str(self.endpoint)
                and profile["workspace"] == beta["workspace"], "profile_binding")
        workspace = private(profile["workspace"], self.uid, True)
        account = private(profile["state_root"], self.uid, True)
        auth = private(profile["auth_file"], self.uid)  # Metadata only; NEVER digest/read.
        require(auth.name == "auth.json", "canonical_auth_reference")
        for a, b in ((workspace, self.home), (account, self.home), (workspace, account),
                     (auth, workspace), (auth, account), (auth, self.home),
                     (self.ledger_directory, self.home), (endpoints, self.home)):
            require(a != b and a not in b.parents and b not in a.parents, "state_scope_overlap")
        for name in ("server", "native", "manager.py", "launcher.py"):
            require((self.root / name).stat().st_mode & 0o111, "executable_required")
        access = beta.get("host_full_access")
        host_providers = type(access) is dict and access.get("providers", True) is True
        packaged = CODE_MODE_HOST in self.manifest["files"]
        # Host natives need their code-mode host; nothing else may carry one.
        require(packaged == host_providers, "code_mode_host_inventory")
        if packaged:
            require((self.root / CODE_MODE_HOST).stat().st_mode & 0o111, "executable_required")
        self._bind_claude(account, auth)

    def _bind_claude(self, codex_account, codex_auth):
        """Optional Claude Deep runtime. Paths only: never read account bytes."""
        self.claude = None
        files = CLAUDE_FILES <= set(self.manifest["files"])
        require(files == ("claude" in self.beta), "claude_inventory")
        if not files:
            return
        selected = self.beta["claude"]
        launcher = self.root / "launcher-claude.py"
        require(type(selected) is dict and set(selected) - {"fast"} == {"launcher", "launcher_sha256", "workspace", "default"}
                and type(selected.get("fast", False)) is bool
                and selected["launcher"] == str(launcher)
                and selected["launcher_sha256"] == digest(launcher)
                and type(selected["default"]) is bool
                and launcher.stat().st_mode & 0o111, "claude_launcher_binding")
        private_config = metadata(self.root / "claude-private.json")
        require(type(private_config) is dict and set(private_config) == {"executable", "account",
                "workspace", "home", "temporary", "host_full_access"}
                and private_config["workspace"] == selected["workspace"]
                and type(private_config["host_full_access"]) is dict, "claude_profile")
        paths = {key: Path(private_config[key]) for key in ("executable", "account", "workspace",
                                                            "home", "temporary")}
        require(all(p.is_absolute() and p.resolve(strict=True) == p for p in paths.values()),
                "claude_profile_paths")
        workspace = private(paths["workspace"], self.uid, True)
        state = [private(paths[key], self.uid, True) for key in ("home", "temporary")]
        for a in [workspace, *state]:
            for b in [self.home, self.root, self.ledger_directory, codex_account, codex_auth]:
                require(a != b and a not in b.parents and b not in a.parents, "claude_scope_overlap")
        self.claude = selected

    def environment(self):
        return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(self.provider_home),
                "ORKESTR_V2_HOME": str(self.data), "ORKESTR_V2_BIND": f"127.0.0.1:{self.runtime['port']}",
                "ORKESTR_V2_BETA_CONFIG": str(self.root / "beta.json"),
                "ORKESTR_V2_UI_DIST": str(self.root / "ui"),
                "ORKESTR_V2_ORIGIN": self.runtime["trusted_origin"],
                ACCESS_LOG_ENV: "all",
                **({METRICS_BIND_ENV: f"127.0.0.1:{self.runtime['port'] + 1}"}
                   if self.runtime["port"] < 65535 else {}),
                **({LIVE_MAP_ENV: self.live_map} if self.live_map else {}),
                **({DESKTOP_BROKER_ENV: self.desktop_broker}
                   if getattr(self, "desktop_broker", None) else {}),
                **({TIMER_CONFIG_ENV: self.timer_config}
                   if getattr(self, "timer_config", None) else {}),
                **({WHATSAPP_CHATS_ENV: self.whatsapp_chats}
                   if getattr(self, "whatsapp_chats", None) else {}),
                **({V1_CHAT_ICONS_ENV: self.v1_chat_icons_dir}
                   if getattr(self, "v1_chat_icons_dir", None) else {})}
