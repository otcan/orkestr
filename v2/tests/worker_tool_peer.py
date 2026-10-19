#!/usr/bin/python3
"""Synthetic native Worker requests one fixed offline tool; no real provider."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import sys
import time
import uuid



def send_tool_request(record, emit, request_id, call_id, params, source):
    fields = {"request_id": request_id, "call_id": call_id,
              "source_digest": hashlib.sha256(source.encode()).hexdigest()}
    # Intent survives immediate refusal/reaping; it does not prove emission.
    record("tool-request-intent", **fields)
    emit({"id": request_id, "method": "item/tool/call", "params": params})
    record("tool-request", **fields)


def main():
    assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
    assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME", "PWD"}
    assert os.environ["HOME"] == os.environ["CODEX_HOME"]
    assert os.environ["PWD"] == os.getcwd()
    workspace = Path.cwd()
    with (workspace / "synthetic-peer-counter").open("a+") as counter:
        fcntl.flock(counter, fcntl.LOCK_EX)
        counter.seek(0)
        ordinal = len(counter.readlines())
        counter.write("spawn\n")
        counter.flush()
    role = "deep" if ordinal == 0 else "worker"
    native = f"synthetic-independent-native-{uuid.uuid4()}"
    identity = {"pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
                "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19])}
    trace = workspace / "synthetic-peer.jsonl"
    mode = json.loads((workspace / "synthetic-tool-case.json").read_text())
    request_id = "tool:" + native
    call_id = "offline-python:1"

    def record(kind, **fields):
        row = {"kind": kind, "pid": os.getpid(), "native": native, "role": role, **identity, **fields}
        line = (json.dumps(row, separators=(",", ":")) + "\n").encode()
        assert len(line) < 4096
        fd = os.open(trace, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            assert os.write(fd, line) == len(line)
        finally:
            os.close(fd)

    def emit(value):
        print(json.dumps(value), flush=True)

    record("spawn")
    active = None
    started = False
    requested = False
    received = False
    completed = False
    progress_sent = False
    buffer = b""
    # Fixed synthetic-only lifetime for actual elapsed lease-renewal tests.
    # This fixture flag is never read by product admission or authority code.
    deadline = time.monotonic() + (120 if mode.get("extended_fixture") else 40)
    while time.monotonic() < deadline:
        if active is not None and not started:
            emit({"method": "turn/started", "params": {"threadId": native,
                  "turn": {"id": active, "status": "inProgress"}}})
            emit({"method": "item/agentMessage/delta", "params": {
                "threadId": native, "turnId": active, "delta": f"synthetic {role} started"}})
            started = True
        if started and role == "worker" and not requested and (workspace / "release-tool-request").exists():
            assert not completed
            params = {"threadId": native, "turnId": active, "callId": call_id,
                      "tool": "orkestr_offline_python", "arguments": {"source": mode["source"]}}
            if mode.get("unsupported"):
                params["tool"] = "arbitrary_shell_is_forbidden"
            send_tool_request(record, emit, request_id, call_id, params, mode["source"])
            requested = True
        if started and not completed and not progress_sent and (workspace / "progress-after-status").exists():
            emit({"method": "item/agentMessage/delta", "params": {
                "threadId": native, "turnId": active, "delta": "synthetic progress while offline tool runs"}})
            record("extra-progress")
            progress_sent = True
        if started and not completed and (role == "deep" or received) and (workspace / f"release-{role}").exists():
            emit({"method": "turn/completed", "params": {"threadId": native,
                  "turn": {"id": active, "status": "completed"}}})
            record("completed", turn=active)
            completed = True
        if not select.select([sys.stdin.fileno()], [], [], 0.01)[0]:
            continue
        chunk = os.read(sys.stdin.fileno(), 8192)
        if not chunk:
            return
        buffer += chunk
        assert len(buffer) <= 65536
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            frame = json.loads(line)
            if "method" not in frame:
                assert role == "worker" and requested and not received and not completed
                assert set(frame) == {"id", "result"} and frame["id"] == request_id
                result = frame["result"]
                assert set(result) == {"success", "contentItems"} and type(result["success"]) is bool
                assert len(result["contentItems"]) == 1
                item = result["contentItems"][0]
                assert set(item) == {"type", "text"} and item["type"] == "inputText"
                assert len(item["text"].encode()) <= 8192
                assert mode["expected_text"] in item["text"]
                assert result["success"] == mode.get("success", True)
                record("tool-result", request_id=request_id, success=result["success"],
                       text_digest=hashlib.sha256(item["text"].encode()).hexdigest())
                emit({"method": "item/agentMessage/delta", "params": {
                    "threadId": native, "turnId": active, "delta": "synthetic Worker received its exact offline result"}})
                received = True
                continue
            method = frame["method"]
            reply = None
            if method == "initialize":
                capabilities = frame["params"].get("capabilities", {}) or {}
                assert bool(capabilities.get("experimentalApi", False)) == (role == "worker")
                reply = {"userAgent": "synthetic", "platformFamily": "unix",
                         "platformOs": "linux", "codexHome": "synthetic-private"}
            elif method == "account/read":
                reply = {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}
            elif method == "thread/start":
                params = frame["params"]
                assert params["modelProvider"] == "openai" and params["cwd"] == str(workspace)
                dynamic = params.get("dynamicTools") or []
                if role == "worker":
                    assert len(dynamic) == 1 and dynamic[0]["name"] == "orkestr_offline_python"
                    assert dynamic[0]["type"] == "function"
                    schema = dynamic[0]["inputSchema"]
                    assert schema["type"] == "object" and schema["additionalProperties"] is False
                    assert schema["required"] == ["source"] and set(schema["properties"]) == {"source"}
                else:
                    assert dynamic == []
                reply = {"modelProvider": "openai", "cwd": str(workspace),
                         "thread": {"id": native, "modelProvider": "openai", "ephemeral": False, "cwd": str(workspace)},
                         "approvalPolicy": "never", "sandbox": {"type": "readOnly"}}
                record("ready")
            elif method == "turn/start":
                assert active is None and frame["params"]["threadId"] == native
                items = frame["params"]["input"]
                assert len(items) == 1 and set(items[0]) == {"type", "text", "text_elements"}
                assert items[0]["type"] == "text" and items[0]["text_elements"] == []
                text = items[0]["text"]
                expected = json.loads((workspace / "expected-tasks.json").read_text())
                if role == "deep":
                    assert text == "synthetic ordinary HTTP input"
                else:
                    assert text in expected.values()
                active = f"synthetic-tool-turn-{uuid.uuid4()}"
                record("turn", turn=active, instructions=text)
                emit({"id": frame["id"], "result": {"turn": {"id": active, "status": "inProgress"}}})
                continue
            elif method == "turn/interrupt":
                assert frame["params"] == {"threadId": native, "turnId": active}
                record("interrupt", turn=active)
                emit({"id": frame["id"], "result": {}})
                if not mode.get("ack_only"):
                    emit({"method": "turn/completed", "params": {"threadId": native,
                          "turn": {"id": active, "status": "interrupted"}}})
                completed = True
                continue
            else:
                assert method == "initialized"
            if reply is not None:
                emit({"id": frame["id"], "result": reply})
    raise AssertionError("synthetic tool peer lifetime exceeded")


if __name__ == "__main__":
    main()
