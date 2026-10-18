#!/usr/bin/python3
"""Synthetic owned broker protocol peer. Never imports a provider or credentials."""
import json
import os
from pathlib import Path
import sys

assert sys.argv[1:] == ["open-owned-session", "--protocol", "orkestr-v2-provider-broker-v1"]
assert set(os.environ) <= {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR"}
trace = Path.cwd() / "synthetic-peer.jsonl"
handle = "synthetic_owned"


def record(kind):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid()}) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


record("spawn")
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "OpenOwnedSession":
        emit({"id": request["id"], "result": {
            "protocol": request["params"]["protocol"],
            "identity": request["params"]["identity"],
            "metadata_only": True, "owned_handle": handle}})
        continue
    assert request["params"]["owned_handle"] == handle
    frame = request["params"]["frame"]
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
        assert request["method"] == "CommitExecution"
        assert frame["params"]["input"][0]["text"] == "synthetic ordinary HTTP input"
        record("turn")
        reply = {"id": frame["id"], "result": {"turn": {"id": "synthetic-turn", "status": "inProgress"}}}
    else:
        assert method == "initialized"
    emit({"id": request["id"], "result": {"owned_handle": handle, "frame": reply}})
    if method == "turn/start":
        for output in [
            {"method": "turn/started", "params": {"threadId": "synthetic-http-native", "turn": {"id": "synthetic-turn", "status": "inProgress"}}},
            {"method": "item/agentMessage/delta", "params": {"threadId": "synthetic-http-native", "turnId": "synthetic-turn", "delta": "synthetic progress <untrusted>"}},
            {"method": "turn/completed", "params": {"threadId": "synthetic-http-native", "turn": {"id": "synthetic-turn", "status": "completed"}}},
        ]:
            emit({"method": "BrokerOutput", "params": {"owned_handle": handle, "frame": output}})
