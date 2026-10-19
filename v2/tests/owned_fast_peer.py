#!/usr/bin/python3
"""Two fixed synthetic roles; native identity survives a verified resume."""
import json
import os
from pathlib import Path
import select
import sys
import time

assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME", "PWD"}
role = Path("role").read_text()
assert role in ("fast", "deep")
native = "synthetic-ordinary-" + role
trace = Path("synthetic-peer.jsonl")
old = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
instance = 1 + sum(row["kind"] == "spawn" for row in old)
turn_number = sum(row["kind"] == "turn" for row in old)


def record(kind, **metadata):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(), "role": role,
            "native": native, "instance": instance,
            "pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
            "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19]),
            **metadata}) + "\n")


def emit(frame):
    print(json.dumps(frame), flush=True)


def terminal(turn, state):
    emit({"method": "turn/completed", "params": {
        "threadId": native, "turn": {"id": turn, "status": state}}})


record("spawn")
for line in sys.stdin:
    frame = json.loads(line)
    method = frame["method"]
    if method == "initialize":
        emit({"id": frame["id"], "result": {"userAgent": "synthetic", "platformFamily": "unix",
              "platformOs": "linux", "codexHome": "synthetic-private"}})
    elif method == "initialized":
        continue
    elif method == "account/read":
        emit({"id": frame["id"], "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}})
    elif method in ("thread/start", "thread/resume"):
        assert method == ("thread/start" if instance == 1 else "thread/resume")
        expected = {"cwd": os.getcwd(), "approvalPolicy": "never", "sandbox": "read-only", "modelProvider": "openai"}
        expected.update({"ephemeral": False} if instance == 1 else {"threadId": native, "excludeTurns": True})
        assert frame["params"] == expected
        emit({"id": frame["id"], "result": {"modelProvider": "openai", "cwd": os.getcwd(),
              "thread": {"id": native, "modelProvider": "openai", "ephemeral": False, "cwd": os.getcwd()},
              "approvalPolicy": "never", "sandbox": {"type": "readOnly", "networkAccess": False}}})
        record("ready", resumed=instance > 1)
    else:
        assert method == "turn/start"
        text = frame["params"]["input"][0]["text"]
        prefix = "synthetic ordinary HTTP input"
        assert text.startswith(prefix)
        number = 1 if text == prefix else int(text.removeprefix(prefix + " "))
        turn_number += 1
        turn = f"synthetic-{role}-{turn_number}"
        record("turn", input_index=number)
        emit({"id": frame["id"], "result": {"turn": {"id": turn, "status": "inProgress"}}})
        emit({"method": "turn/started", "params": {"threadId": native, "turn": {"id": turn, "status": "inProgress"}}})
        emit({"method": "item/agentMessage/delta", "params": {"threadId": native,
              "turnId": turn, "delta": "synthetic " + role + " progress"}})
        mode = Path("mode").read_text()
        assert mode in ("complete", "hold", "ack-only")
        if mode == "complete":
            terminal(turn, "completed")
            continue
        deadline = time.monotonic() + 90
        while not Path("release-" + str(number)).exists():
            assert time.monotonic() < deadline
            if not select.select([sys.stdin], [], [], .01)[0]:
                continue
            raw = sys.stdin.readline()
            if not raw:
                raise SystemExit(0)
            interrupt = json.loads(raw)
            assert interrupt["method"] == "turn/interrupt"
            assert interrupt["params"] == {"threadId": native, "turnId": turn}
            record("interrupt", input_index=number)
            emit({"id": interrupt["id"], "result": {}})
            if mode == "ack-only":
                assert not sys.stdin.read()
                raise SystemExit(0)
            terminal(turn, "interrupted")
            break
        else:
            terminal(turn, "completed")
