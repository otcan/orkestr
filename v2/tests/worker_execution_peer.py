#!/usr/bin/python3
"""Two independent synthetic native sessions behind the ordinary product broker."""
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
    assert os.environ["PWD"] == os.getcwd()
    workspace = Path.cwd()
    # Only synthetic fixture ordering. Product role/parent authority is verified
    # independently against Store bindings; this counter grants no product rights.
    with (workspace / "synthetic-peer-counter").open("a+") as counter:
        fcntl.flock(counter, fcntl.LOCK_EX)
        counter.seek(0)
        ordinal = len(counter.readlines())
        counter.write("spawn\n")
        counter.flush()
    native = f"synthetic-independent-native-{uuid.uuid4()}"
    role = "deep" if ordinal == 0 else "worker"
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
    started = False
    extra_progress = False
    timeout = time.monotonic() + 40
    while time.monotonic() < timeout:
        if active is not None and not started:
            if not (workspace / f"hold-{role}-started").exists() or (workspace / f"release-{role}-started").exists():
                emit({"method": "turn/started", "params": {"threadId": native,
                    "turn": {"id": active, "status": "inProgress"}}})
                emit({"method": "item/agentMessage/delta", "params": {
                    "threadId": native, "turnId": active,
                    "delta": f"synthetic {role} independent progress"}})
                started = True
        if started and not completed and not extra_progress and (workspace / "progress-after-status").exists():
            emit({"method": "item/agentMessage/delta", "params": {
                "threadId": native, "turnId": active,
                "delta": f"synthetic {role} progress after control status"}})
            record("extra-progress")
            extra_progress = True
        if active is not None and started and not completed:
            held = (workspace / f"hold-{role}").exists()
            released = (workspace / f"release-{role}").exists()
            if not held or released:
                emit({"method": "turn/completed", "params": {
                    "threadId": native, "turn": {"id": active, "status": "completed"}}})
                record("completed", turn=active)
                completed = True
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
                reply = {"userAgent": "synthetic", "platformFamily": "unix",
                         "platformOs": "linux", "codexHome": "synthetic-private"}
            elif method == "account/read":
                reply = {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}
            elif method == "thread/start":
                assert frame["params"]["modelProvider"] == "openai"
                assert frame["params"]["cwd"] == str(workspace)
                reply = {"modelProvider": "openai", "cwd": str(workspace),
                         "thread": {"id": native, "modelProvider": "openai",
                                    "ephemeral": False, "cwd": str(workspace)},
                         "approvalPolicy": "never", "sandbox": {"type": "readOnly"}}
                record("ready")
            elif method == "turn/start":
                assert active is None, "this distinct Worker fixture is single use"
                assert frame["params"]["threadId"] == native
                assert frame["params"]["input"] == [{"type": "text",
                    "text": "synthetic ordinary HTTP input", "text_elements": []}]
                active = f"synthetic-turn-{os.getpid()}"
                record("turn", turn=active, message=frame["params"]["clientUserMessageId"])
                emit({"id": frame["id"], "result": {"turn": {
                    "id": active, "status": "inProgress"}}})
                continue
            elif method == "turn/interrupt":
                assert frame["params"]["threadId"] == native
                assert frame["params"]["turnId"] == active
                record("interrupt", turn=active)
                emit({"id": frame["id"], "result": {}})
                if (workspace / f"{role}-late-progress").exists():
                    for index in range(32):
                        emit({"method": "item/agentMessage/delta", "params": {
                            "threadId": native, "turnId": active,
                            "delta": f"synthetic late progress {index}"}})
                    record("late-progress", count=32)
                if not (workspace / f"{role}-ack-only").exists():
                    emit({"method": "turn/completed", "params": {"threadId": native,
                        "turn": {"id": active, "status": "interrupted"}}})
                completed = True
                continue
            else:
                assert method == "initialized"
            if reply is not None:
                emit({"id": frame["id"], "result": reply})
    raise AssertionError("synthetic Worker peer lifetime exceeded")


if __name__ == "__main__":
    main()
