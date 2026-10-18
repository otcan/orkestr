#!/usr/bin/env python3
"""Unprivileged V2 directory-package launcher. All homes and ports are explicit."""
import argparse
import json
import os
import platform
from pathlib import Path
import signal
import socket
import sys

from helper import Client, require, start, stop
from install_state import (config, free_port, initialize, locked, package, private_home,
                           sha256, unprivileged, upgrade)


def release(home):
    current = config(home)
    root, manifest = package(home / "releases" / current["release"])
    require(sha256(root / "manifest.json") == current["release"], "release manifest identity mismatch")
    return current, root, manifest


def identity(home):
    current, root, manifest = release(home)
    return {"version": manifest["version"], "source_commit": manifest["source_commit"],
            "target": manifest["target"], "release": current["release"],
            "home": str(home), "bind": f'127.0.0.1:{current["port"]}',
            "schema": "server-owned; compatibility unverified", "ui_packaged": manifest.get("ui", False),
            "execution": "disabled in intake server", "connections": "none configured by launcher"}


def child_environment(home, root, port):
    token_path = home / "control" / "bootstrap.token"
    require(not token_path.is_symlink() and token_path.stat().st_mode & 0o077 == 0,
            "bootstrap file must be private and not a symlink")
    token = token_path.read_text()
    require(len(token) >= 32, "invalid private bootstrap file")
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "TMPDIR") if key in os.environ}
    env.update(HOME=str(home / "provider-home"), ORKESTR_V2_HOME=str(home / "data"),
               ORKESTR_V2_BIND=f"127.0.0.1:{port}", ORKESTR_V2_BOOTSTRAP_TOKEN=token)
    if (root / "ui").is_dir():
        env["ORKESTR_V2_UI_DIST"] = str(root / "ui")
        env["ORKESTR_V2_ORIGIN"] = f"http://127.0.0.1:{port}"
    return env


def control_path(home):
    path = home / "control" / "launcher.sock"
    require(len(os.fsencode(path)) < 100, "home too long for portable POSIX control socket; choose shorter path")
    return path


def serve(home):
    unprivileged()
    home = private_home(home)
    process = None
    with locked(home):
        require(not (home / "control/restore-dormant.json").exists() and
                not (home / "control/restore-dormant.json").is_symlink(),
                "dormant restore prohibits activation; rollback required")
        current, root, manifest = release(home)
        require(manifest["target"] == f"{platform.system().lower()}-{platform.machine().lower()}",
                "package platform does not match host; no child started")
        free_port(current["port"])
        path = control_path(home)
        require(not path.is_symlink(), "control socket symlink refused")
        # Lock ownership proves no other managed launcher owns this stale control socket.
        if path.exists():
            require(path.is_socket(), "unexpected control file; inspect manually")
            path.unlink()
        print(json.dumps(identity(home), sort_keys=True), flush=True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as control:
            control.bind(str(path))
            path.chmod(0o600)
            control.listen(1)
            control.settimeout(0.25)
            previous = signal.getsignal(signal.SIGTERM)
            def interrupted(*_):
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM, interrupted)
            try:
                process = start(root / "server" / "orkestr-v2-server", home / "logs",
                                child_environment(home, root, current["port"]), Client(current["port"]))
                print("READY; stop with this package's stop --home command or Ctrl-C", flush=True)
                while process.poll() is None:
                    try:
                        connection, _ = control.accept()
                    except socket.timeout:
                        continue
                    with connection:
                        connection.settimeout(1)
                        try:
                            request = connection.recv(16)
                            if request == b"stop\n":
                                connection.sendall(b"stopping\n")
                                break
                        except (OSError, TimeoutError):
                            pass
                else:
                    require(process.returncode == 0, "server exited unexpectedly; inspect logs")
            finally:
                if process is not None:
                    stop(process)
                signal.signal(signal.SIGTERM, previous)
                path.unlink(missing_ok=True)


def request_stop(home):
    unprivileged()
    home = private_home(home)
    path = control_path(home)
    require(not path.is_symlink() and path.is_socket(), "no managed launcher socket; no process signalled")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(path))
        connection.sendall(b"stop\n")
        require(connection.recv(32) == b"stopping\n", "launcher did not accept stop")
    return {"status": "stop requested; wait for foreground launcher to exit before upgrade/backup"}


def doctor(home, health=False):
    home = private_home(home)
    report = identity(home)
    child_environment(home, home / "releases" / config(home)["release"], config(home)["port"])
    control_path(home)
    try:
        with locked(home):
            report["launcher"] = "stopped"
    except RuntimeError:
        report["launcher"] = "busy"
    report["health"] = "unexecuted"
    if health:
        Client(config(home)["port"]).health()
        report["health"] = "passed; HTTP identity only"
    report["platform_acceptance"] = "unexecuted; package hashes do not prove runtime compatibility"
    report["restore"] = "same-package dormant apply/rollback only; activation and migration gated"
    return report


def logs(home, lines):
    home = private_home(home)
    require(1 <= lines <= 1000, "lines must be 1..1000")
    path = home / "logs" / "server.log"
    require(not path.is_symlink(), "log symlink refused")
    # Bound memory even if a long-running server has a large log.
    with path.open("rb") as stream:
        stream.seek(0, 2)
        stream.seek(max(0, stream.tell() - 256 * 1024))
        return b"\n".join(stream.read().splitlines()[-lines:]).decode("utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("install")
    init.add_argument("--package", required=True)
    init.add_argument("--home", required=True)
    init.add_argument("--port", type=int, required=True)
    change = commands.add_parser("upgrade")
    change.add_argument("--package", required=True)
    change.add_argument("--home", required=True)
    for name in ("start", "stop", "version", "doctor", "logs", "backup", "restore-preview", "restore-apply", "restore-rollback"):
        command = commands.add_parser(name)
        command.add_argument("--home", required=True)
        if name == "doctor":
            command.add_argument("--health", action="store_true")
        if name == "logs":
            command.add_argument("--lines", type=int, default=100)
        if name == "backup":
            command.add_argument("--output", required=True)
        if name in ("restore-preview", "restore-apply"):
            command.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    try:
        unprivileged()
        if args.command == "install":
            home = initialize(args.home, args.package, args.port)
            result = identity(home)
        elif args.command == "upgrade":
            upgrade(args.home, args.package)
            result = {"status": "package selected; no server restarted or database migrated", **identity(private_home(args.home))}
        elif args.command == "start":
            serve(args.home)
            return 0
        elif args.command == "stop":
            result = request_stop(args.home)
        elif args.command == "doctor":
            result = doctor(args.home, args.health)
        elif args.command == "version":
            result = identity(private_home(args.home))
        elif args.command == "logs":
            print(logs(args.home, args.lines))
            return 0
        else:
            from recovery import backup, restore_preview, restore_apply, restore_rollback
            if args.command == "restore-apply":
                result = restore_apply(args.home, args.snapshot)
            elif args.command == "restore-rollback":
                result = restore_rollback(args.home)
            else:
                result = (backup(args.home, args.output) if args.command == "backup" else
                      restore_preview(args.home, args.snapshot))
        print(json.dumps(result, sort_keys=True, indent=2))
    except KeyboardInterrupt:
        return 130
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
