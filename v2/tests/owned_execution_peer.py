#!/usr/bin/python3
"""Synthetic native peer behind the real broker. No provider or credentials."""
import json
import os
from pathlib import Path
import sys

assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME"}
assert os.environ["HOME"] == os.environ["CODEX_HOME"]
trace = Path.cwd() / "synthetic-peer.jsonl"


def record(kind):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid()}) + "\n")


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
        assert frame["params"]["input"][0]["text"] == "synthetic ordinary HTTP input"
        record("turn")
        reply = {"id": frame["id"], "result": {"turn": {"id": "synthetic-turn", "status": "inProgress"}}}
    else:
        assert method == "initialized"
    if reply is not None:
        emit(reply)
    if method == "turn/start":
        for output in [
            {"method": "turn/started", "params": {"threadId": "synthetic-http-native", "turn": {"id": "synthetic-turn", "status": "inProgress"}}},
            {"method": "item/agentMessage/delta", "params": {"threadId": "synthetic-http-native", "turnId": "synthetic-turn", "delta": "synthetic progress <untrusted>"}},
            {"method": "turn/completed", "params": {"threadId": "synthetic-http-native", "turn": {"id": "synthetic-turn", "status": "completed"}}},
        ]:
            emit(output)
