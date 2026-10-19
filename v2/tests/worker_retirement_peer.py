#!/usr/bin/python3
"""Fixed synthetic parent/Worker lifecycle; no account, tools or external I/O."""
import fcntl
import json
import os
from pathlib import Path
import select
import sys
import time
import uuid


def main():
    assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
    assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME", "PWD"}
    assert os.environ["HOME"] == os.environ["CODEX_HOME"]
    workspace = Path.cwd()
    assert os.environ["PWD"] == str(workspace)
    with (workspace / "retirement-peer-counter").open("a+") as counter:
        fcntl.flock(counter, fcntl.LOCK_EX)
        counter.seek(0)
        ordinal = len(counter.readlines())
        counter.write("spawn\n")
        counter.flush()
    # This only selects a synthetic response script. The HTTP oracle separately
    # verifies actual Core roles, native identities, scope and parent bindings.
    role = "deep" if ordinal == 0 or (workspace / "restart-parent").exists() else "worker"
    native = f"synthetic-reap-{uuid.uuid4()}"
    target = role
    trace = workspace / "synthetic-peer.jsonl"
    identity = {"pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
                "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19])}

    def record(kind, **fields):
        value = {"kind": kind, "pid": os.getpid(), "native": native, "role": role, **identity, **fields}
        line = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        assert len(line) < 4096
        fd = os.open(trace, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            assert os.write(fd, line) == len(line)
        finally:
            os.close(fd)

    def emit(value):
        print(json.dumps(value), flush=True)

    record("spawn")
    buffer = b""
    active = None
    completed = False
    setup = None
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if active and not completed and (workspace / f"release-{target}").exists():
            emit({"method": "turn/completed", "params": {
                "threadId": native, "turn": {"id": active, "status": "completed"}}})
            record("completed", turn=active, target=target)
            completed = True
            if role == "worker" and (workspace / "worker-exit-after-proposal").exists():
                os._exit(17)
        if not select.select([sys.stdin.fileno()], [], [], 0.01)[0]:
            continue
        chunk = os.read(sys.stdin.fileno(), 8192)
        if not chunk:
            return
        buffer += chunk
        assert len(buffer) < 65536
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            frame = json.loads(line)
            method = frame["method"]
            reply = None
            if method == "initialize":
                reply = {"userAgent": "synthetic", "platformFamily": "unix", "platformOs": "linux",
                         "codexHome": "synthetic-private"}
            elif method == "account/read":
                reply = {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}
            elif method in ("thread/start", "thread/resume"):
                assert setup is None
                params = {"cwd": str(workspace), "approvalPolicy": "never", "sandbox": "read-only",
                          "modelProvider": "openai"}
                if method == "thread/resume":
                    assert role == "deep" and (workspace / "restart-parent").exists()
                    native = (workspace / "expected-parent-native").read_text()
                    params.update({"threadId": native, "excludeTurns": True})
                else:
                    params["ephemeral"] = False
                assert frame["params"] == params
                setup = method
                if role == "worker" and (workspace / "hold-worker-setup").exists():
                    record("setup-held")
                    continue
                reply = {"modelProvider": "openai", "cwd": str(workspace),
                         "thread": {"id": native, "modelProvider": "openai", "ephemeral": False,
                                    "cwd": str(workspace)},
                         "approvalPolicy": "never", "sandbox": {"type": "readOnly"}}
                record("ready", resumed=method == "thread/resume")
            elif method == "turn/start":
                assert active is None or (role == "deep" and completed)
                assert frame["params"]["threadId"] == native
                items = frame["params"]["input"]
                assert len(items) == 1 and set(items[0]) == {"type", "text", "text_elements"}
                assert items[0]["type"] == "text" and items[0]["text_elements"] == []
                instructions = items[0]["text"]
                if role == "deep":
                    prefix = "synthetic ordinary HTTP input"
                    assert instructions.startswith(prefix)
                    suffix = instructions[len(prefix):]
                    assert suffix in ("", " 2", " 3", " 4")
                    target = "deep-" + (suffix.strip() or "1")
                else:
                    expected = json.loads((workspace / "expected-tasks.json").read_text())
                    matches = [name for name, text in expected.items() if text == instructions]
                    assert len(matches) == 1
                    target = matches[0]
                active = f"synthetic-turn-{uuid.uuid4()}"
                completed = False
                record("turn", turn=active, message=frame["params"]["clientUserMessageId"], task=target,
                       instructions=instructions)
                emit({"id": frame["id"], "result": {"turn": {"id": active, "status": "inProgress"}}})
                emit({"method": "turn/started", "params": {"threadId": native,
                     "turn": {"id": active, "status": "inProgress"}}})
                emit({"method": "item/agentMessage/delta", "params": {"threadId": native,
                     "turnId": active, "delta": "synthetic retirement progress"}})
                continue
            elif method == "turn/interrupt":
                assert frame["params"] == {"threadId": native, "turnId": active}
                record("interrupt", turn=active, target=target)
                emit({"id": frame["id"], "result": {}})
                if not (workspace / f"{role}-ack-only").exists():
                    emit({"method": "turn/completed", "params": {"threadId": native,
                        "turn": {"id": active, "status": "interrupted"}}})
                completed = True
                continue
            else:
                assert method == "initialized"
            if reply is not None:
                emit({"id": frame["id"], "result": reply})
    raise AssertionError("synthetic retirement peer exceeded bound")


if __name__ == "__main__":
    main()
