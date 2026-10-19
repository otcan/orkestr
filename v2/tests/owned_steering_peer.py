#!/usr/bin/python3
"""Synthetic native steer protocol behind the unchanged production broker."""
import hashlib
import json
import os
from pathlib import Path
import select
import sys
import time

assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME", "PWD"}
assert os.environ["HOME"] == os.environ["CODEX_HOME"]
assert os.environ["PWD"] == os.getcwd()
trace = Path("synthetic-peer.jsonl")
native = "synthetic-steering-native"
turn = 0
active = False
pending_ack = None
buffer = bytearray()
deadline = time.monotonic() + 65


def record(kind, **values):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(),
            "pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
            "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19]),
            **values}) + "\n")


def emit(frame):
    print(json.dumps(frame), flush=True)


def completed(status):
    emit({"method": "turn/completed", "params": {"threadId": native,
          "turn": {"id": f"steer-turn-{turn}", "status": status}}})


record("spawn")
while time.monotonic() < deadline:
    if active and Path(f"complete-{turn}").exists():
        completed("completed")
        active = False
    if pending_ack and Path("release-steer-ack").exists():
        emit(pending_ack)
        pending_ack = None
    if not select.select([0], [], [], .01)[0]:
        continue
    chunk = os.read(0, 65536)
    if not chunk:
        break
    buffer.extend(chunk)
    assert len(buffer) <= 131072
    while b"\n" in buffer:
        line, _, remaining = buffer.partition(b"\n")
        buffer = bytearray(remaining)
        frame = json.loads(line)
        method = frame["method"]
        if method == "initialize":
            emit({"id": frame["id"], "result": {"userAgent": "synthetic", "platformFamily": "unix",
                  "platformOs": "linux", "codexHome": "synthetic-private"}})
        elif method == "initialized":
            pass
        elif method == "account/read":
            emit({"id": frame["id"], "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}})
        elif method == "thread/start":
            assert frame["params"]["modelProvider"] == "openai"
            emit({"id": frame["id"], "result": {"modelProvider": "openai", "cwd": os.getcwd(),
                  "thread": {"modelProvider": "openai", "id": native, "ephemeral": False, "cwd": os.getcwd()},
                  "approvalPolicy": "never", "sandbox": {"type": "readOnly"}}})
            record("ready")
        elif method == "turn/start":
            assert not active
            turn += 1
            active = True
            record("turn", turn=turn, text=frame["params"]["input"][0]["text"])
            emit({"id": frame["id"], "result": {"turn": {"id": f"steer-turn-{turn}", "status": "inProgress"}}})
            emit({"method": "turn/started", "params": {"threadId": native,
                  "turn": {"id": f"steer-turn-{turn}", "status": "inProgress"}}})
            emit({"method": "item/agentMessage/delta", "params": {"threadId": native,
                  "turnId": f"steer-turn-{turn}", "delta": "synthetic initial progress"}})
        elif method == "turn/steer":
            assert active and set(frame) == {"id", "method", "params"}
            params = frame["params"]
            assert set(params) == {"threadId", "expectedTurnId", "input"}
            assert params["threadId"] == native and params["expectedTurnId"] == f"steer-turn-{turn}"
            assert len(params["input"]) == 1 and set(params["input"][0]) == {"type", "text", "text_elements"}
            assert params["input"][0]["type"] == "text" and params["input"][0]["text_elements"] == []
            record("steer", request=frame["id"], text_sha256=hashlib.sha256(params["input"][0]["text"].encode()).hexdigest())
            ack = {"id": frame["id"], "result": {"turnId": f"steer-turn-{turn}"}}
            if Path("wrong-turn-ack").exists():
                ack["result"]["turnId"] = "foreign-turn"
            if Path("hold-steer-ack").exists():
                pending_ack = ack
            elif not Path("missing-steer-ack").exists():
                emit(ack)
        elif method == "turn/interrupt":
            assert active and frame["params"] == {"threadId": native, "turnId": f"steer-turn-{turn}"}
            record("interrupt")
            emit({"id": frame["id"], "result": {}})
            completed("interrupted")
            active = False
        else:
            raise AssertionError("unexpected native request")
