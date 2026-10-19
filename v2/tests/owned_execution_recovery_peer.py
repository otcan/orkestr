#!/usr/bin/python3
"""Fixed synthetic native resume peer. No provider, credentials, or tool calls."""
import json
import os
from pathlib import Path
import sys

assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CODEX_HOME", "PWD"}
assert os.environ["HOME"] == os.environ["CODEX_HOME"]
assert os.environ["PWD"] == os.getcwd()
trace = Path("synthetic-peer.jsonl")
prior = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
old = [row for row in prior if row["kind"] == "spawn"]
# The external fixture checks host identities. Namespace-local native PIDs are
# never used as host disappearance evidence or as cleanup authority.
instance = len(old) + 1
native = "synthetic-recovery-native"
mode = Path("recovery-mode").read_text()
assert mode in ("stop", "ack-only", "restart")


def record(kind, **metadata):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(), "instance": instance,
            "pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
            "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19]),
            **metadata}) + "\n")


def emit(frame):
    print(json.dumps(frame), flush=True)


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
        params = {"cwd": os.getcwd(), "approvalPolicy": "never", "sandbox": "read-only", "modelProvider": "openai"}
        params.update({"ephemeral": False} if instance == 1 else {"threadId": native, "excludeTurns": True})
        assert frame["params"] == params
        emit({"id": frame["id"], "result": {"modelProvider": "openai", "cwd": os.getcwd(),
              "thread": {"id": native, "modelProvider": "openai", "ephemeral": False, "cwd": os.getcwd()},
              "approvalPolicy": "never", "sandbox": {"type": "readOnly", "networkAccess": False}}})
        record("ready", resumed=instance > 1)
    else:
        assert method == "turn/start"
        # The pre-Stop second input is intentionally absent from eligible native
        # work. These fixed expected bytes independently catch accidental replay.
        number = 1 if instance == 1 else (2 if mode == "restart" else 3)
        expected = "synthetic ordinary HTTP input" + (f" {number}" if number > 1 else "")
        assert frame["params"]["input"][0]["text"] == expected
        turn = f"synthetic-recovery-turn-{instance}"
        record("turn", input_index=number)
        emit({"id": frame["id"], "result": {"turn": {"id": turn, "status": "inProgress"}}})
        emit({"method": "turn/started", "params": {"threadId": native, "turn": {"id": turn, "status": "inProgress"}}})
        emit({"method": "item/agentMessage/delta", "params": {"threadId": native, "turnId": turn, "delta": "synthetic recovery progress"}})
        terminal = "completed"
        if instance == 1 and mode in ("stop", "ack-only"):
            interrupt = json.loads(sys.stdin.readline())
            assert interrupt["method"] == "turn/interrupt"
            assert interrupt["params"] == {"threadId": native, "turnId": turn}
            record("interrupt")
            emit({"id": interrupt["id"], "result": {}})
            if mode == "ack-only":
                assert not sys.stdin.read()
                break
            terminal = "interrupted"
        emit({"method": "turn/completed", "params": {"threadId": native, "turn": {"id": turn, "status": terminal}}})
