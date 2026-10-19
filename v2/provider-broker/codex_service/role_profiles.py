"""Fixed companion/worker profiles; requests never select executable paths."""
import re

from codex_bounded.configuration import HOSTS
from codex_bounded.trust import digest, metadata, private
from .contract import require

ROLE_NAMES = ("fast", "worker-0", "worker-1", "worker-2", "worker-3")
ROLE_FILES = {name for role in ROLE_NAMES for name in
              (f"launcher-{role}.py", f"profile-{role}.json")}


def entries(roles):
    require(type(roles) is dict and set(roles) == {"fast", "workers"}, "roles_format")
    require(type(roles["workers"]) is list and len(roles["workers"]) == 4,
            "worker_slot_inventory")
    return [("fast", roles["fast"]), *[(f"worker-{i}", value)
            for i, value in enumerate(roles["workers"])]]


def bind(package):
    package.role_profiles = {"deep": package.root / "profile.json"}
    roles = package.beta.get("roles")
    if "roles" not in package.beta:
        require(not (ROLE_FILES & set(package.manifest["files"])), "unexpected_role_files")
        return
    require(ROLE_FILES <= set(package.manifest["files"]), "missing_role_files")
    state_paths = [private(package.profile["state_root"], package.uid, True)]
    shared_auth = package.profile["auth_file"]
    workspaces = [private(package.profile["workspace"], package.uid, True)]
    for role, value in entries(roles):
        require(type(value) is dict and set(value) ==
                {"launcher", "launcher_sha256", "workspace"}, "role_configuration")
        launcher = package.root / f"launcher-{role}.py"
        require(value["launcher"] == str(launcher) and
                type(value["launcher_sha256"]) is str and
                re.fullmatch(r"[0-9a-f]{64}", value["launcher_sha256"]) and
                value["launcher_sha256"] == digest(launcher) and
                launcher.stat().st_mode & 0o111, "role_launcher_binding")
        path = package.root / f"profile-{role}.json"
        profile = metadata(path)
        require(set(profile) == set(package.profile) and
                all(profile[key] == package.profile[key] for key in
                    ("format", "native", "auth_file", "egress_socket", "supervisor", "hosts")) and
                profile["hosts"] == list(HOSTS) and profile["auth_file"] == shared_auth and
                profile["workspace"] == value["workspace"], "role_profile_binding")
        state_paths.append(private(profile["state_root"], package.uid, True))
        workspaces.append(private(profile["workspace"], package.uid, True))
        package.role_profiles[role] = path
    auth = private(shared_auth, package.uid)
    for workspace in workspaces[1:]:
        for other in [package.root, package.home, state_paths[0], auth,
                      package.ledger_directory, package.control.parent]:
            require(workspace != other and workspace not in other.parents and
                    other not in workspace.parents, "role_workspace_scope_overlap")
    # Workspaces are read-only and may intentionally be shared. Writable native
    # homes are disjoint across every role/slot, auth and application state.
    for index, state in enumerate(state_paths):
        for other in [*state_paths[index + 1:], *workspaces, auth, package.home,
                      package.ledger_directory, package.control.parent]:
            require(state != other and state not in other.parents and
                    other not in state.parents, "role_state_scope_overlap")
