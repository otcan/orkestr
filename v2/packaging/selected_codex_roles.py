#!/usr/bin/python3
"""Prepare two fixed selected-Codex roles in one finite ordinary execution window."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from selected_codex import SOURCE, encoded, entrypoint, source_blob, write
from codex_bounded.configuration import BROKER, HOSTS, ISOLATION, ROLE_FILES, ROLE_MODULES, ROLES, Package
from codex_bounded.roles import disjoint
from codex_bounded.trust import digest, metadata, private, protected, require


def launcher(role):
    require(role in ROLES, "fixed_role_required")
    return ("#!/usr/bin/python3 -I\nimport sys\nfrom pathlib import Path\n"
            "sys.dont_write_bytecode = True\nroot = Path(__file__).resolve().parent\n"
            "sys.path.insert(0, str(root))\nfrom codex_bounded.broker import main\n"
            f"raise SystemExit(main(root, {role!r}))\n").encode()


def prepare(plan):
    require(os.geteuid() == 0, "root_preparation_required")
    fields = {"format", "output", "source_repository", "source_commit", "server", "native", "uid", "gid",
              "home", "roles", "auth_file", "egress_directory", "bootstrap_file", "machine_token_file",
              "conversation_id", "port", "lifetime_seconds"}
    require(set(plan) == fields and plan["format"] == "orkestr-v2-codex-bounded-roles-plan-v1", "roles_plan_format")
    require(re.fullmatch(r"[0-9a-f]{40}", plan["source_commit"]), "exact_source_required")
    uid, gid = plan["uid"], plan["gid"]
    require(type(uid) is int and type(gid) is int and 0 < uid < 2**31 and 0 < gid < 2**31,
            "unprivileged_executor_required")
    require(type(plan["port"]) is int and 1024 <= plan["port"] <= 65535, "loopback_port")
    require(type(plan["lifetime_seconds"]) is int and 1 <= plan["lifetime_seconds"] <= 900,
            "finite_controller_lifetime")
    conversation = uuid.UUID(plan["conversation_id"])
    require(conversation.int != 0 and str(conversation) == plan["conversation_id"], "exact_conversation_required")
    output, endpoint = Path(plan["output"]), Path(plan["egress_directory"])
    for path in (output, endpoint):
        require(path.is_absolute() and not path.exists() and not path.is_symlink(), "fresh_destination_required")
        protected(path.parent, True)
    disjoint([output, endpoint])
    home = private(plan["home"], uid, True)
    private(home / "data", uid, True)
    private(home / "provider-home", uid, True)
    private(plan["bootstrap_file"], uid)
    private(plan["machine_token_file"], uid)
    auth = private(plan["auth_file"], uid)  # Stat only; selected account is never opened.
    require(auth.name == "auth.json", "canonical_auth_reference")
    require(type(plan["roles"]) is dict and set(plan["roles"]) == set(ROLES), "exact_role_inventory")
    isolated, configs = [home, auth], {}
    for role in ROLES:
        value = plan["roles"][role]
        require(set(value) == {"workspace", "state_root", "namespace", "supervisor_key"}, "role_plan_fields")
        for key in ("namespace", "supervisor_key"):
            require(isinstance(value[key], str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value[key]),
                    "role_scope_key")
        workspace = private(value["workspace"], uid, True)
        account = private(value["state_root"], uid, True)
        require(not any(account.iterdir()), "fresh_native_state_required")
        isolated.extend((workspace, account))
        configs[role] = home / f"selected-{role}.json"
    for key in ("namespace", "supervisor_key"):
        require(len({plan["roles"][role][key] for role in ROLES}) == len(ROLES), "role_authority_alias")
    disjoint(isolated)
    execution_set = home / "selected-executions.json"
    for path in (*configs.values(), execution_set):
        require(not path.exists() and not path.is_symlink(), "fresh_execution_config_required")
    server, native = protected(plan["server"]), protected(plan["native"])
    require(server.stat().st_mode & 0o111 and native.stat().st_mode & 0o111, "executable_required")
    server_bytes = server.read_bytes()
    identities = set(re.findall(rb"ORKESTR_V2_BUILD_IDENTITY_V1\|server\|[A-Za-z0-9.+-]{1,64}\|([0-9a-f]{40}|unknown)\|END", server_bytes))
    require(server_bytes[:4] == b"\x7fELF" and identities == {plan["source_commit"].encode()},
            "same_commit_server_required")
    native_bytes = native.read_bytes()
    require(native_bytes[:4] == b"\x7fELF", "native_elf_required")
    repository = Path(plan["source_repository"]).resolve(strict=True)
    for name in ("selected_codex.py", "selected_codex_roles.py"):
        require(source_blob(repository, plan["source_commit"], "v2/packaging/" + name)
                == Path(__file__).with_name(name).read_bytes(), "same_commit_packager_required")
    source = {}
    for directory, names in (("broker", BROKER), ("isolation", ISOLATION), ("codex_bounded", ROLE_MODULES)):
        for name in names:
            relative = "v2/provider-broker/" + ("" if directory == "broker" else directory + "/") + name
            source[directory + "/" + name] = source_blob(repository, plan["source_commit"], relative)
            current = SOURCE / ("" if directory == "broker" else directory) / name
            require(source[directory + "/" + name] == current.read_bytes(), "same_commit_modules_required")
    for directory in (output, endpoint):
        directory.mkdir(mode=0o750)
        os.chown(directory, 0, gid)
    for name in ("broker", "isolation", "codex_bounded"):
        (output / name).mkdir(mode=0o750)
        os.chown(output / name, 0, gid)
    for name, content in source.items():
        write(output / name, content, gid, 0o550 if name == "isolation/supervisor.py" else 0o440)
    write(output / "server", server_bytes, gid, 0o550)
    write(output / "native", native_bytes, gid, 0o550)
    write(output / "controller.py", entrypoint("controller"), gid, 0o550)
    for role in ROLES:
        value = plan["roles"][role]
        selected_launcher = output / f"launcher-{role}.py"
        write(selected_launcher, launcher(role), gid, 0o550)
        execution = {"schema_version": 1, "mode": "isolated-acceptance-v1", "role": role, "provider": "codex",
                     "conversation_id": plan["conversation_id"], "machine_token_file": plan["machine_token_file"],
                     "launcher": str(selected_launcher), "launcher_sha256": digest(selected_launcher),
                     "workspace": value["workspace"], "namespace": value["namespace"],
                     "supervisor_key": value["supervisor_key"]}
        write(configs[role], encoded(execution), gid, 0o600, uid)
        profile = {"format": "orkestr-v2-codex-isolated-v2", "native": str(output / "native"),
                   "auth_file": str(auth), "state_root": value["state_root"], "workspace": value["workspace"],
                   "egress_socket": str(endpoint / "egress.sock"), "supervisor": str(output / "isolation/supervisor.py"),
                   "hosts": list(HOSTS)}
        write(output / f"profile-{role}.json", encoded(profile), gid)
    write(execution_set, encoded({"schema_version": 1, "mode": "isolated-acceptance-set-v1",
                                 "configurations": [str(configs[role]) for role in ROLES]}), gid, 0o600, uid)
    runtime = {"format": "orkestr-v2-codex-bounded-roles-runtime-v1", "uid": uid, "gid": gid,
               "home": str(home), "execution_set": str(execution_set), "execution_set_sha256": digest(execution_set),
               "executions": {role: {"path": str(configs[role]), "sha256": digest(configs[role])} for role in ROLES},
               "bootstrap_file": plan["bootstrap_file"], "port": plan["port"], "lifetime_seconds": plan["lifetime_seconds"]}
    write(output / "runtime.json", encoded(runtime), gid)
    dependencies = {str(Path(p).resolve(strict=True)) for p in (
        "/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/prlimit", "/etc/ssl/certs/ca-certificates.crt")}
    manifest = {"format": "orkestr-v2-codex-bounded-roles-package-v1", "source_commit": plan["source_commit"],
                "files": {name: digest(output / name) for name in sorted(ROLE_FILES)},
                "dependencies": {path: digest(protected(path)) for path in sorted(dependencies)}}
    write(output / "manifest.json", encoded(manifest), gid)
    pin = digest(output / "manifest.json")
    Package(output, pin)
    return {"package": str(output), "manifest_sha256": pin, "source_commit": plan["source_commit"],
            "roles": list(ROLES), "activated": False, "provider_invoked": False, "credential_contents_read": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(metadata(protected(args.plan)))))
        return 0
    except Exception:
        sys.stderr.write("selected Codex role package refused; no activation\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
