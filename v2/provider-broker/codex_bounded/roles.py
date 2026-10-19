"""Two fixed role profiles; ordinary Core remains the only execution authority."""
from pathlib import Path
import re
import stat
import uuid

from .configuration import HOSTS, ROLES
from .trust import digest, metadata, private, protected, require


def disjoint(paths):
    for index, a in enumerate(paths):
        for b in paths[index + 1:]:
            require(a != b and a not in b.parents and b not in a.parents, "role_state_scope_overlap")


def bind(package):
    value = package.runtime
    require(set(value) == {"format", "uid", "gid", "home", "execution_set", "execution_set_sha256",
                          "executions", "bootstrap_file", "port", "lifetime_seconds"}
            and value["format"] == "orkestr-v2-codex-bounded-roles-runtime-v1", "roles_runtime_format")
    require(all(type(value[k]) is int and 0 < value[k] < 2**31 for k in ("uid", "gid")), "runtime_identity")
    require(type(value["port"]) is int and 1024 <= value["port"] <= 65535, "loopback_port")
    require(type(value["lifetime_seconds"]) is int and 1 <= value["lifetime_seconds"] <= 900,
            "finite_controller_lifetime")
    package.uid, package.gid = value["uid"], value["gid"]
    package.home = private(value["home"], package.uid, True)
    package.data = private(package.home / "data", package.uid, True)
    package.provider_home = private(package.home / "provider-home", package.uid, True)
    private(value["bootstrap_file"], package.uid)
    manifest = private(value["execution_set"], package.uid)
    require(manifest == package.home / "selected-executions.json"
            and digest(manifest) == value["execution_set_sha256"], "execution_set_pin")
    require(type(value["executions"]) is dict and set(value["executions"]) == set(ROLES),
            "exact_role_inventory")
    expected_paths = [str(package.home / f"selected-{role}.json") for role in ROLES]
    registry = metadata(manifest, 16384)
    require(registry == {"schema_version": 1, "mode": "isolated-acceptance-set-v1",
                         "configurations": expected_paths}, "execution_set_binding")
    package.executions, package.profiles = {}, {}
    isolated = [package.home]
    shared = {name: set() for name in ("conversation_id", "machine_token_file", "auth_file", "egress_socket")}
    distinct = {name: set() for name in ("namespace", "supervisor_key")}
    for role in ROLES:
        entry = value["executions"][role]
        require(set(entry) == {"path", "sha256"}, "role_execution_pin_format")
        config_path = private(entry["path"], package.uid)
        require(config_path == package.home / f"selected-{role}.json"
                and digest(config_path) == entry["sha256"], "role_execution_pin")
        execution = metadata(config_path, 16384)
        required = {"schema_version", "mode", "role", "provider", "conversation_id", "machine_token_file",
                    "launcher", "launcher_sha256", "workspace", "namespace", "supervisor_key"}
        require(set(execution) == required and execution["schema_version"] == 1
                and execution["mode"] == "isolated-acceptance-v1" and execution["role"] == role
                and execution["provider"] == "codex", "exact_execution_role")
        conversation = uuid.UUID(execution["conversation_id"])
        require(conversation.int != 0 and str(conversation) == execution["conversation_id"],
                "exact_conversation_required")
        launcher = package.root / f"launcher-{role}.py"
        require(execution["launcher"] == str(launcher)
                and execution["launcher_sha256"] == digest(launcher), "role_launcher_binding")
        for name in distinct:
            key = execution[name]
            require(isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", key), "role_scope_key")
            distinct[name].add(key)
        private(execution["machine_token_file"], package.uid)  # Stat only; ordinary server authenticates.
        profile = metadata(package.root / f"profile-{role}.json")
        require(set(profile) == {"format", "native", "auth_file", "state_root", "workspace",
                                 "egress_socket", "supervisor", "hosts"}
                and profile["format"] == "orkestr-v2-codex-isolated-v2", "role_profile_format")
        require(profile["native"] == str(package.root / "native")
                and profile["supervisor"] == str(package.root / "isolation/supervisor.py")
                and profile["hosts"] == list(HOSTS), "role_profile_artifact_binding")
        for path in (package.root / "server", package.root / "native", launcher):
            require(path.stat().st_mode & 0o111, "executable_required")
        workspace = private(profile["workspace"], package.uid, True)
        account = private(profile["state_root"], package.uid, True)
        auth = private(profile["auth_file"], package.uid)  # Never read or hash canonical auth.
        require(auth.name == "auth.json", "canonical_auth_reference")
        require(str(workspace) == execution["workspace"], "role_workspace_binding")
        isolated.extend((workspace, account))
        for name in shared:
            shared[name].add(execution[name] if name in execution else profile[name])
        package.executions[role], package.profiles[role] = execution, profile
    require(all(len(values) == 1 for values in shared.values()), "role_shared_scope_mismatch")
    require(all(len(values) == len(ROLES) for values in distinct.values()), "role_authority_alias")
    disjoint([*isolated, auth])
    package.endpoint = Path(next(iter(shared["egress_socket"])))
    require(package.endpoint.is_absolute() and len(bytes(package.endpoint)) < 100
            and package.endpoint.name == "egress.sock", "endpoint_path")
    protected(package.endpoint.parent, True)
    require(not package.endpoint.is_symlink(), "endpoint_alias")
    if package.endpoint.exists():
        info = package.endpoint.lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == package.gid
                and stat.S_IMODE(info.st_mode) == 0o660, "endpoint_identity")
