#!/usr/bin/env python3
"""Prepare fresh V2-only Docker context/Compose JSON; no Docker calls or builds."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import sys
import struct
from urllib.parse import urlsplit

LOCAL = Path(__file__).resolve().parents[2] / "local-install"
sys.path.insert(0, str(LOCAL))
from install_state import fresh_path, sha256, write_json
from helper import require

HERE = Path(__file__).resolve().parent
RESERVED = {"ORKESTR_V2_HOME", "ORKESTR_V2_BIND", "ORKESTR_V2_ORIGIN", "ORKESTR_V2_UI_DIST",
            "ORKESTR_V2_BOOTSTRAP_TOKEN", "ORKESTR_V2_MASTER_KEY"}


def ui_files(root):
    """Complete web inventory; web manifest.json is an artifact, not metadata."""
    inventory = {}
    require(root.is_dir() and not root.is_symlink(), "regular UI directory required")
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "symlinks are not allowed in web artifacts")
        if path.is_dir():
            continue
        require(path.is_file(), "only regular web files are allowed")
        inventory[path.relative_to(root).as_posix()] = sha256(path)
    return inventory


def elf_platform(binary):
    with binary.open("rb") as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b"\x7fELF\x02\x01",
            "64-bit little-endian Linux ELF required; macOS binaries cannot run in this image")
    machine = struct.unpack_from("<H", header, 18)[0]
    require(machine in (62, 183), "unsupported ELF architecture")
    return "linux/amd64" if machine == 62 else "linux/arm64"


def prepare(binary, ui, output, binary_sha256, ui_inventory_sha256, source_commit,
            ui_source_commit, base_image, origin, port, bind_opt_in, required_glibc,
            network_policy="outbound-denied"):
    require(network_policy in ("outbound-denied", "diagnostic-egress-allowed"),
            "explicit supported network policy required")
    require(re.fullmatch(r"[^\s$;]+@sha256:[0-9a-f]{64}", base_image), "immutable inspected local base image digest required")
    require(1024 <= port <= 65535, "explicit unprivileged host port required")
    parsed = urlsplit(origin)
    require(origin == f"http://127.0.0.1:{port}" and parsed.hostname == "127.0.0.1",
            "exact explicit loopback browser origin must match published port")
    require(re.fullmatch(r"2\.[0-9]+", required_glibc), "declared required glibc version required")
    require(bind_opt_in == "ORKESTR_V2_CONTAINER_BIND=1", "reviewed ORKESTR_V2_CONTAINER_BIND=1 contract required")
    name, separator, value = bind_opt_in.partition("=")
    require(separator and re.fullmatch(r"ORKESTR_V2_[A-Z0-9_]+", name) and name not in RESERVED
            and re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", value), "reviewed runtime bind opt-in NAME=VALUE required")
    for commit in (source_commit, ui_source_commit):
        require(re.fullmatch(r"[0-9a-f]{40}", commit), "full artifact source commits required")
    binary, ui = Path(binary).resolve(), Path(ui).resolve()
    require(binary.is_file() and sha256(binary) == binary_sha256, "assigned binary hash mismatch")
    platform = elf_platform(binary)
    require((ui / "index.html").is_file(), "built web index required")
    inventory = ui_files(ui)
    digest = hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    require(digest == ui_inventory_sha256, "assigned UI inventory hash mismatch")
    output = fresh_path(output, [binary, ui, HERE])
    output.mkdir(mode=0o700)
    # Interrupted preparation stays private and never starts/builds a container.
    shutil.copy2(binary, output / "server")
    (output / "server").chmod(0o555)
    shutil.copytree(ui, output / "ui")
    for filename in ("Dockerfile", "entrypoint.py"):
        shutil.copy2(HERE / filename, output / filename)
    require(sha256(output / "server") == binary_sha256 and ui_files(output / "ui") == inventory,
            "copied artifact identity changed")
    project = "v2-install-" + secrets.token_hex(6)
    manifest = {"format": "orkestr-v2-container-artifacts-v1", "project": project,
                "server_source_commit_declared": source_commit, "ui_source_commit_declared": ui_source_commit,
                "origin": origin, "base_image": base_image, "platform": platform,
                "required_glibc_declared": required_glibc, "network_policy": network_policy,
                "provider_activation": "none; no provider configured by this distribution", "container_bind_opt_in": {"name": name, "value": value},
                "files": {"server": binary_sha256, "entrypoint.py": sha256(output / "entrypoint.py"),
                          **{"ui/" + key: value for key, value in inventory.items()}},
                "acceptance": "unexecuted; reviewed bind-capable binary and compatible inspected base required"}
    write_json(output / "artifact-manifest.json", manifest)
    service = {"image": project + ":local", "platform": platform, "build": {"context": ".", "args": {"BASE_IMAGE": base_image}},
               "pull_policy": "never", "user": "10001:10001", "read_only": True,
               "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "pids_limit": 64,
               "restart": "no", "stop_signal": "SIGINT", "stop_grace_period": "10s",
               "ports": [{"target": 19822, "published": str(port), "host_ip": "127.0.0.1", "protocol": "tcp"}],
               "environment": {"ORKESTR_V2_ORIGIN": origin, name: value},
               "volumes": ["state:/state"], "tmpfs": ["/tmp:rw,noexec,nosuid,size=16m,uid=10001,gid=10001"],
               "networks": ["isolated"], "healthcheck": {"test": ["CMD", "python3", "-c",
                   "import urllib.request; urllib.request.urlopen('http://127.0.0.1:19822/api/v2/health',timeout=2)"],
                   "interval": "2s", "timeout": "3s", "retries": 15}}
    write_json(output / "compose.json", {"name": project, "services": {"server": service},
               "volumes": {"state": {"name": project + "-state"}}, "networks": {"isolated": {"internal": network_policy == "outbound-denied"}}})
    (output / ".dockerignore").write_text("**\n!Dockerfile\n!server\n!ui\n!ui/**\n!entrypoint.py\n!artifact-manifest.json\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("binary", "ui", "output", "binary-sha256", "ui-inventory-sha256", "source-commit",
                 "ui-source-commit", "base-image", "origin", "bind-opt-in", "required-glibc"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--network-policy", choices=("outbound-denied", "diagnostic-egress-allowed"),
                        default="outbound-denied", help="normal bridge permits outbound routing; requires explicit topology admission")
    parser.add_argument("--port", type=int, required=True)
    args = vars(parser.parse_args())
    try:
        print(prepare(**args))
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"FAIL: {error}\n")
