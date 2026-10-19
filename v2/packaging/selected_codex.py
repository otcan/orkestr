#!/usr/bin/python3
"""Prepare a fresh protected Codex composition; never start a provider or service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[1] / "provider-broker"
sys.path.insert(0, str(SOURCE))
from codex_bounded.configuration import BROKER, FILES, HOSTS, ISOLATION, MODULES, Package
from codex_bounded.trust import digest, metadata, private, protected, require


def entrypoint(kind):
    body = ("from codex_bounded.broker import main\nraise SystemExit(main(root))\n" if kind == "broker" else
            "from codex_bounded.controller import main\n"
            "if len(sys.argv) != 2: raise SystemExit(2)\n"
            "raise SystemExit(main(root, sys.argv[1]))\n")
    return ("#!/usr/bin/python3 -I\nimport sys\nfrom pathlib import Path\n"
            "sys.dont_write_bytecode = True\nroot = Path(__file__).resolve().parent\n"
            "sys.path.insert(0, str(root))\n" + body).encode()


def source_blob(repository, commit, path):
    # Read exact Git blobs, not dirty working files or replacement objects.
    command = ["git", "-c", "safe.directory=" + str(repository), "-C", str(repository),
               "cat-file", "blob", commit + ":" + path]
    result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=10, env={"PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"})
    require(len(result.stdout) <= 1024 * 1024, "source_module_bound")
    return result.stdout


def write(path, content, gid, mode=0o440, uid=0):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, mode)
    with os.fdopen(descriptor, "wb") as stream:
        os.fchown(stream.fileno(), uid, gid)
        os.fchmod(stream.fileno(), mode)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def prepare(plan):
    require(os.geteuid() == 0, "root_preparation_required")
    fields = {"format", "output", "source_repository", "source_commit", "server", "native", "uid", "gid",
              "home", "workspace", "state_root", "auth_file", "egress_directory", "bootstrap_file",
              "machine_token_file", "conversation_id", "namespace", "supervisor_key", "port", "lifetime_seconds"}
    require(set(plan) == fields and plan["format"] == "orkestr-v2-codex-bounded-plan-v1", "plan_format")
    require(re.fullmatch(r"[0-9a-f]{40}", plan["source_commit"]), "exact_source_required")
    uid, gid = plan["uid"], plan["gid"]
    require(type(uid) is int and type(gid) is int and 0 < uid < 2**31 and 0 < gid < 2**31,
            "unprivileged_executor_required")
    output = Path(plan["output"])
    endpoint = Path(plan["egress_directory"])
    for path in (output, endpoint):
        require(path.is_absolute() and not path.exists() and not path.is_symlink(), "fresh_destination_required")
        protected(path.parent, True)
    require(output != endpoint and output not in endpoint.parents and endpoint not in output.parents,
            "package_endpoint_overlap")
    home = private(plan["home"], uid, True)
    private(home / "data", uid, True)
    private(home / "provider-home", uid, True)
    private(plan["workspace"], uid, True)
    account = private(plan["state_root"], uid, True)
    require(not any(account.iterdir()), "fresh_native_state_required")
    auth = private(plan["auth_file"], uid)  # Stat only: never copy/hash/read the selected account.
    require(auth.name == "auth.json", "canonical_auth_reference")
    private(plan["bootstrap_file"], uid)
    private(plan["machine_token_file"], uid)
    config = home / "selected-execution.json"
    require(not config.exists() and not config.is_symlink(), "fresh_execution_config_required")
    server = protected(plan["server"])
    native = protected(plan["native"])
    require(server.stat().st_mode & 0o111 and native.stat().st_mode & 0o111, "executable_required")
    server_bytes = server.read_bytes()
    identities = set(re.findall(rb"ORKESTR_V2_BUILD_IDENTITY_V1\|server\|[A-Za-z0-9.+-]{1,64}\|([0-9a-f]{40}|unknown)\|END", server_bytes))
    require(server_bytes[:4] == b"\x7fELF" and identities == {plan["source_commit"].encode()},
            "same_commit_server_required")
    native_bytes = native.read_bytes()
    require(native_bytes[:4] == b"\x7fELF", "native_elf_required")
    repository = Path(plan["source_repository"]).resolve(strict=True)
    require(source_blob(repository, plan["source_commit"], "v2/packaging/selected_codex.py") ==
            Path(__file__).read_bytes(), "same_commit_packager_required")
    source = {}
    for directory, names in (("broker", BROKER), ("isolation", ISOLATION), ("codex_bounded", MODULES)):
        for name in names:
            relative = "v2/provider-broker/" + ("" if directory == "broker" else directory + "/") + name
            source[directory + "/" + name] = source_blob(repository, plan["source_commit"], relative)
            current = SOURCE / ("" if directory == "broker" else directory) / name
            require(source[directory + "/" + name] == current.read_bytes(), "same_commit_modules_required")
    # Seal source first; no account resolution or executable invocation occurs.
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
    write(output / "launcher.py", entrypoint("broker"), gid, 0o550)
    write(output / "controller.py", entrypoint("controller"), gid, 0o550)
    execution = {"schema_version": 1, "mode": "isolated-acceptance-v1",
                 "conversation_id": plan["conversation_id"], "machine_token_file": plan["machine_token_file"],
                 "launcher": str(output / "launcher.py"), "launcher_sha256": digest(output / "launcher.py"),
                 "workspace": plan["workspace"], "namespace": plan["namespace"], "supervisor_key": plan["supervisor_key"]}
    write(config, encoded(execution), gid, 0o600, uid)
    profile = {"format": "orkestr-v2-codex-isolated-v2", "native": str(output / "native"),
               "auth_file": str(auth), "state_root": plan["state_root"], "workspace": plan["workspace"],
               "egress_socket": str(endpoint / "egress.sock"), "supervisor": str(output / "isolation/supervisor.py"),
               "hosts": list(HOSTS)}
    runtime = {"format": "orkestr-v2-codex-bounded-runtime-v1", "uid": uid, "gid": gid,
               "home": str(home), "execution_config": str(config), "execution_config_sha256": digest(config),
               "bootstrap_file": plan["bootstrap_file"], "port": plan["port"], "lifetime_seconds": plan["lifetime_seconds"]}
    write(output / "profile.json", encoded(profile), gid)
    write(output / "runtime.json", encoded(runtime), gid)
    dependencies = {str(Path(p).resolve(strict=True)) for p in (
        "/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/prlimit", "/etc/ssl/certs/ca-certificates.crt")}
    manifest = {"format": "orkestr-v2-codex-bounded-package-v1", "source_commit": plan["source_commit"],
                "files": {name: digest(output / name) for name in sorted(FILES)},
                "dependencies": {path: digest(protected(path)) for path in sorted(dependencies)}}
    write(output / "manifest.json", encoded(manifest), gid)
    pin = digest(output / "manifest.json")
    Package(output, pin)
    return {"package": str(output), "manifest_sha256": pin, "source_commit": plan["source_commit"],
            "activated": False, "provider_invoked": False, "credential_contents_read": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    try:
        plan = metadata(protected(args.plan))
        print(json.dumps(prepare(plan)))
        return 0
    except Exception:
        # Leave any failed fresh preparation in place for attended diagnosis.
        sys.stderr.write("selected Codex package preparation refused; no activation\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
