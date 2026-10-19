#!/usr/bin/env python3
"""Opt-in real native package probe; requires assigned isolated parent and port.

No builds, external providers, existing homes, browser automation. Restore apply remains offline and dormant.
Evidence stdout contains hashes/check names only; generated private state is removed.
"""
import argparse
from contextlib import closing, contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

LOCAL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCAL))
from helper import Client, require, smoke, verify_history
from install_state import files, free_port, sha256
from recovery import validate_snapshot

SPEC = importlib.util.spec_from_file_location("package_builder", LOCAL.parent / "packaging/package.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def invoke(entrypoint, command, home, *extra, expected=0):
    result = subprocess.run([str(entrypoint), command, "--home", str(home), *map(str, extra)],
                            capture_output=True, text=True, timeout=40)
    require(result.returncode == expected, f"{command} exit mismatch; private diagnostic withheld")
    return result


def fetch(client, path):
    with client.opener.open(client.base.removesuffix("/api/v2") + path, timeout=3) as response:
        require(response.status == 200, "static response status mismatch")
        return response.read()


def stop_owned(process):
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            # Never guess/kill a child PID on a hung supervisor. Caller must inspect.
            raise RuntimeError("owned supervisor did not stop; preserve private diagnostic directory")


def launch(entrypoint, home, client, log):
    process = subprocess.Popen([str(entrypoint), "start", "--home", str(home)],
                               stdout=log, stderr=log, start_new_session=True)
    try:
        for _ in range(150):
            require(process.poll() is None, "real launcher exited before readiness; inspect private diagnostic")
            try:
                client.health()
                return process
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                time.sleep(0.1)
        raise RuntimeError("real launcher health deadline exceeded")
    except BaseException:
        stop_owned(process)
        raise


@contextmanager
def private_probe(parent):
    directory = tempfile.mkdtemp(prefix="v2pkg-", dir=parent)
    try:
        yield directory
    except BaseException:
        print(f"FAILED probe retained privately: {directory}", file=sys.stderr)
        raise
    else:
        shutil.rmtree(directory)


def exercise(args):
    binary = Path(args.binary).resolve()
    ui = Path(args.ui_dist).resolve()
    require(sha256(binary) == args.expected_binary_sha256, "producer binary SHA-256 differs from assigned artifact")
    require((ui / "index.html").is_file(), "actual built UI index required")
    free_port(args.port)
    inventory = files(ui)
    evidence = {"binary_sha256": sha256(binary), "ui_index_sha256": sha256(ui / "index.html"),
                "ui_inventory_sha256": hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                "ui_file_count": len(inventory), "source_commit_declared": args.source_commit,
                "ui_source_commit_declared": args.ui_source_commit,
                "scope": "mixed-revision installation/HTTP checkpoint; not current candidate browser/execution acceptance",
                "checks": [], "unexecuted": ["macOS", "Docker", "browser interaction", "cross-version restore", "live providers", "remote CI", "cross-version schema compatibility", "mount/inode alias isolation"]}
    parent = Path(args.parent)
    require(parent.is_absolute() and parent.is_dir(), "assigned existing absolute parent required")
    with private_probe(parent) as directory:
        root = Path(directory).resolve()
        os.chmod(root, 0o700)
        package = builder.assemble(binary, root / "package", "0.1.0-real-probe", args.source_commit, ui)
        require(sha256(package / "server/orkestr-v2-server") == args.expected_binary_sha256,
                "copied binary differs from assigned artifact")
        require(files(package / "ui") == inventory, "copied UI inventory differs from producer snapshot")
        entrypoint = package / "bin/orkestr-v2"
        home = root / "home"
        invoke(entrypoint, "install", home, "--package", package, "--port", args.port)
        require(json.loads(invoke(entrypoint, "version", home).stdout)["source_commit"] == args.source_commit,
                "installed version identity mismatch")
        require(json.loads(invoke(entrypoint, "doctor", home).stdout)["launcher"] == "stopped", "initial doctor state")
        evidence["checks"].append("real package/install/version/offline doctor")
        client = Client(args.port)
        process = None
        with (root / "probe.log").open("wb") as log:
            try:
                process = launch(entrypoint, home, client, log)
                report = json.loads(invoke(entrypoint, "doctor", home, "--health").stdout)
                require(report["launcher"] == "busy" and report["health"].startswith("passed"), "running doctor state")
                require(fetch(client, "/") == (ui / "index.html").read_bytes(), "served UI index bytes mismatch")
                require(any(name.endswith(".wasm") for name in inventory), "actual WASM web bundle required")
                require(any(name.endswith(".js") for name in inventory), "actual generated JavaScript required")
                for relative in inventory:
                    require(fetch(client, "/" + relative) == (ui / relative).read_bytes(), "served asset bytes mismatch")
                evidence["wasm_sha256"] = {name: digest for name, digest in inventory.items() if name.endswith(".wasm")}
                evidence["checks"].append(f"real health/doctor/UI index and all {len(inventory)} generated assets byte-for-byte")
                bootstrap = (home / "control/bootstrap.token").read_text()
                path, receipt, message = smoke(client, bootstrap)
                evidence["checks"].append("real synthetic auth/admission/idempotency/history")
                rejected = invoke(entrypoint, "backup", home, "--output", root / "busy-snapshot", expected=1)
                require("busy" in rejected.stderr and not (root / "busy-snapshot").exists(), "running backup must refuse")
                rejected = invoke(entrypoint, "upgrade", home, "--package", package, expected=1)
                require("busy" in rejected.stderr, "running upgrade must refuse")
                invoke(entrypoint, "stop", home)
                require(process.wait(timeout=10) == 0, "owned stop exit mismatch")
                process = None
                free_port(args.port)
                require(not (home / "control/launcher.sock").exists(), "control socket not removed")
                evidence["checks"].append("real busy backup/upgrade refusal and owned-child stop/port release")
                invoke(entrypoint, "backup", home, "--output", root / "snapshot")
                snapshot, manifest = validate_snapshot(root / "snapshot")
                with closing(sqlite3.connect((snapshot / "core.sqlite3").as_uri() + "?mode=ro&immutable=1", uri=True)) as database:
                    count = database.execute("SELECT count(*) FROM messages").fetchone()[0]
                require(count == 1, "real snapshot message count mismatch")
                evidence["snapshot_message_count"] = count
                evidence["snapshot_database_sha256"] = manifest["files"]["core.sqlite3"]
                evidence["checks"].append("real stopped SQLite API backup/integrity/hash/message count")
                dormant = root / "dormant-home"
                invoke(entrypoint, "install", dormant, "--package", package, "--port", args.port)
                dormant_before = {name: (dormant / name).read_bytes() for name in
                                  ("install.json", "control/bootstrap.token")}
                invoke(entrypoint, "restore-apply", dormant, "--snapshot", snapshot)
                with closing(sqlite3.connect((dormant / "data/core.sqlite3").as_uri() + "?mode=ro&immutable=1", uri=True)) as database:
                    require(database.execute("SELECT count(*) FROM messages").fetchone()[0] == count,
                            "dormant applied history count mismatch")
                require(sha256(dormant / "data/core.sqlite3") == manifest["files"]["core.sqlite3"],
                        "dormant applied database hash mismatch")
                rejected = invoke(entrypoint, "start", dormant, expected=1)
                require("dormant" in rejected.stderr, "dormant launcher activation not refused")
                invoke(entrypoint, "restore-rollback", dormant)
                require(not any((dormant / "data").iterdir()), "rollback did not restore empty target")
                require(all((dormant / name).read_bytes() == value for name, value in dormant_before.items()),
                        "restore changed target config/bootstrap")
                evidence["checks"].append("actual same-package dormant apply/hash/history, activation refusal and rollback; target auth/config unchanged")
                process = launch(entrypoint, home, client, log)
                verify_history(client, path, receipt, message)
                require(client.request("POST", path + "/messages", message) == (200, receipt), "real restart receipt mismatch")
                invoke(entrypoint, "stop", home)
                require(process.wait(timeout=10) == 0, "restart stop exit mismatch")
                process = None
                evidence["checks"].append("real restart/session/history/receipt persistence")
                newer = builder.assemble(package / "server/orkestr-v2-server", root / "newer-package", "0.1.1-real-probe", args.source_commit, package / "ui")
                invoke(newer / "bin/orkestr-v2", "upgrade", home, "--package", newer)
                require(json.loads(invoke(entrypoint, "version", home).stdout)["version"] == "0.1.1-real-probe", "upgrade selection")
                process = launch(entrypoint, home, client, log)
                verify_history(client, path, receipt, message)
                invoke(entrypoint, "stop", home)
                require(process.wait(timeout=10) == 0, "upgrade stop exit mismatch")
                process = None
                free_port(args.port)
                evidence["checks"].append("same-binary version-label package switch/restart/history; no cross-version schema claim")
                require(json.loads(invoke(entrypoint, "doctor", home).stdout)["launcher"] == "stopped", "final stopped doctor")
                evidence["checks"].append("final stopped doctor/port released; synthetic directory cleanup")
            finally:
                if process is not None:
                    stop_owned(process)
    evidence["status"] = "passed"
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("binary", "ui-dist", "source-commit", "ui-source-commit", "expected-binary-sha256", "parent"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    print(json.dumps(exercise(args), sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
