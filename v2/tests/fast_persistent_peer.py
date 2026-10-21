#!/usr/bin/python3
"""Fixed synthetic Fast presentation peer; supports actual same-child and resume."""
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
    saved = workspace / "synthetic-fast-native"
    resumed = saved.exists()
    native = saved.read_text() if resumed else "synthetic-fast-" + str(uuid.uuid4())
    if not resumed:
        saved.write_text(native)
    identity = {"pid": os.getpid(), "native": native,
                "pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
                "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19])}

    def record(kind, **fields):
        with (workspace / "synthetic-peer.jsonl").open("a") as stream:
            stream.write(json.dumps({**identity, "kind": kind, **fields}) + "\n")

    def emit(value):
        print(json.dumps(value), flush=True)

    record("spawn")
    buffer, active, completed = b"", None, False
    deadline = time.monotonic() + 80
    while time.monotonic() < deadline:
        if active and not completed and (workspace / f"release-{active}").exists():
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
        assert len(buffer) <= 65536
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            frame = json.loads(line)
            method, reply = frame["method"], None
            if method == "initialize":
                reply = {"userAgent": "synthetic", "platformFamily": "unix",
                         "platformOs": "linux", "codexHome": "synthetic-private"}
            elif method == "account/read":
                reply = {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}
            elif method in ("thread/start", "thread/resume"):
                assert method == ("thread/resume" if resumed else "thread/start")
                expected = {"modelProvider": "openai", "cwd": str(workspace),
                            "approvalPolicy": "never", "sandbox": "read-only"}
                expected.update({"threadId": native, "excludeTurns": True} if resumed else {"ephemeral": False})
                assert frame["params"] == expected
                reply = {"modelProvider": "openai", "cwd": str(workspace),
                         "thread": {"id": native, "modelProvider": "openai", "ephemeral": False,
                                    "cwd": str(workspace)},
                         "approvalPolicy": "never", "sandbox": {"type": "readOnly"}}
                record(method)
            elif method == "turn/start":
                assert active is None or completed
                assert frame["params"]["threadId"] == native
                items = frame["params"]["input"]
                assert len(items) == 1 and set(items[0]) == {"type", "text", "text_elements"}
                note, separator, text = items[0]["text"].partition("\n\n")
                # Every Fast turn carries the quick-reply note before the input.
                assert separator and note.startswith("[Fast reply:")
                assert items[0]["type"] == "text" and items[0]["text_elements"] == []
                number = int(text.rsplit(" ", 1)[1])
                assert text == f"synthetic Fast source {number}" and 1 <= number <= 8
                active, completed = f"fast-turn-{number}", False
                record("turn", turn=active, text=text, message=frame["params"]["clientUserMessageId"])
                emit({"id": frame["id"], "result": {"turn": {"id": active, "status": "inProgress"}}})
                emit({"method": "turn/started", "params": {
                    "threadId": native, "turn": {"id": active, "status": "inProgress"}}})
                emit({"method": "item/agentMessage/delta", "params": {
                    "threadId": native, "turnId": active, "delta": f"synthetic Fast output {number}"}})
                continue
            elif method == "turn/interrupt":
                assert active and not completed
                assert frame["params"] == {"threadId": native, "turnId": active}
                record("interrupt", turn=active)
                emit({"id": frame["id"], "result": {}})
                if not (workspace / "ack-only").exists():
                    emit({"method": "turn/completed", "params": {
                        "threadId": native, "turn": {"id": active, "status": "interrupted"}}})
                    record("interrupted", turn=active)
                completed = True
                continue
            else:
                assert method == "initialized"
            if reply is not None:
                emit({"id": frame["id"], "result": reply})
    raise AssertionError("synthetic Fast peer deadline exceeded")


if __name__ == "__main__":
    main()
