#!/usr/bin/python3
"""Synthetic native peer behind the real broker. No provider or credentials."""
import json
import os
from pathlib import Path
import sys
import time

assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME", "PWD"}
assert os.environ["HOME"] == os.environ["CODEX_HOME"]
assert os.environ["PWD"] == os.getcwd()
trace = Path.cwd() / "synthetic-peer.jsonl"
turn = 0


def record(kind):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(),
            "pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
            "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19])}) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


record("spawn")
for line in sys.stdin:
    frame = json.loads(line)
    method = frame["method"]
    reply = None
    if method == "initialize":
        reply = {"id": frame["id"], "result": {
            "userAgent": "synthetic", "platformFamily": "unix",
            "platformOs": "linux", "codexHome": "synthetic-private"}}
    elif method == "account/read":
        reply = {"id": frame["id"], "result": {
            "requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}}
    elif method == "thread/start":
        assert frame["params"]["modelProvider"] == "openai"
        reply = {"id": frame["id"], "result": {
            "modelProvider": "openai", "cwd": os.getcwd(),
            "thread": {"modelProvider": "openai", "id": "synthetic-http-native",
                       "ephemeral": False, "cwd": os.getcwd()},
            "approvalPolicy": "never", "sandbox": {"type": "readOnly"}}}
        record("ready")
    elif method == "turn/start":
        turn += 1
        text = "synthetic ordinary HTTP input" + (f" {turn}" if turn > 1 else "")
        assert frame["params"]["input"][0]["text"] == text
        record("turn")
        reply = {"id": frame["id"], "result": {"turn": {"id": f"synthetic-turn-{turn}", "status": "inProgress"}}}
    else:
        assert method == "initialized"
    if reply is not None:
        emit(reply)
    if method == "turn/start":
        for output in [
            {"method": "turn/started", "params": {"threadId": "synthetic-http-native", "turn": {"id": f"synthetic-turn-{turn}", "status": "inProgress"}}},
            {"method": "item/agentMessage/delta", "params": {"threadId": "synthetic-http-native", "turnId": f"synthetic-turn-{turn}", "delta": "synthetic progress <untrusted>"}},
        ]:
            emit(output)
        if Path("stop-mode").exists():
            mode = Path("stop-mode").read_text()
            assert mode in ("terminal", "ack-only")
            if Path("hold-before-stop").exists():
                deadline = time.monotonic() + 15
                while not Path("release-progress").exists():
                    assert time.monotonic() < deadline
                    time.sleep(0.01)
                emit({"method": "item/agentMessage/delta", "params": {
                    "threadId": "synthetic-http-native", "turnId": f"synthetic-turn-{turn}",
                    "delta": "synthetic interleaved progress"}})
                record("interleaved-progress")
            interrupt = json.loads(sys.stdin.readline())
            assert interrupt["method"] == "turn/interrupt"
            assert interrupt["params"] == {"threadId": "synthetic-http-native", "turnId": f"synthetic-turn-{turn}"}
            record("interrupt")
            emit({"id": interrupt["id"], "result": {}})
            record("interrupt-ack")
            if mode == "ack-only":
                # An ACK without terminal evidence must remain unresolved.
                assert not sys.stdin.read()
                break
            deadline = time.monotonic() + 15
            while not Path("release-stop").exists():
                assert time.monotonic() < deadline
                time.sleep(0.01)
            if Path("late-stop-progress").exists():
                # Native progress already in flight is valid after an interrupt
                # ACK. It cannot be mistaken for terminal evidence or conceal it.
                for _ in range(32):
                    emit({"method": "item/agentMessage/delta", "params": {
                        "threadId": "synthetic-http-native", "turnId": f"synthetic-turn-{turn}",
                        "delta": "synthetic late progress"}})
            emit({"method": "turn/completed", "params": {"threadId": "synthetic-http-native",
                "turn": {"id": f"synthetic-turn-{turn}", "status": "interrupted"}}})
            continue
        # A test-owned barrier keeps the first turn in flight. It does not sleep
        # for an assumed scheduling interval or alter any product checkpoint.
        deadline = time.monotonic() + 15
        while turn == 1 and Path("hold-first").exists() and not Path("release-first").exists():
            assert time.monotonic() < deadline
            time.sleep(0.01)
        emit({"method": "turn/completed", "params": {"threadId": "synthetic-http-native",
            "turn": {"id": f"synthetic-turn-{turn}", "status": "completed"}}})
