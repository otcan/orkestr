#!/usr/bin/python3
"""Fixed synthetic Claude stream peer, no external provider or credentials."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

prefix = ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
          "--verbose", "--permission-mode", "dontAsk", "--permission-prompts", "none",
          "--safe-mode", "--restricted", "--disable-slash-commands", "--no-chrome",
          "--prompt-suggestions", "false", "--tools", "", "--strict-mcp-config",
          "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--session-id"]
assert sys.argv[1:-1] == prefix
native = str(uuid.UUID(sys.argv[-1]))
assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "PWD"}
assert os.environ["PWD"] == os.getcwd()
assert not list(Path(os.environ["CLAUDE_CONFIG_DIR"]).iterdir())


def record(kind):
    with Path("synthetic-peer.jsonl").open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(), "native": native,
            "pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
            "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19])}) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


def barrier(name):
    deadline = time.monotonic() + 15
    while not Path(name).exists():
        assert time.monotonic() < deadline, "synthetic barrier timed out"
        time.sleep(0.005)


record("spawn")
frame = json.loads(sys.stdin.readline())
assert frame == {"type": "control_request", "request_id": "initialize:2",
                 "request": {"subtype": "initialize", "hooks": None}}
emit({"type": "control_response", "response": {"subtype": "success",
      "request_id": frame["request_id"], "response": {},
      "pending_permission_requests": [], "pending_user_dialog_requests": []}})
record("initialized")
frame = json.loads(sys.stdin.readline())
input_uuid = frame.pop("uuid")
assert input_uuid == str(uuid.UUID(input_uuid))
assert frame == {"type": "user", "session_id": native, "parent_tool_use_id": None,
                 "message": {"role": "user", "content": "synthetic ordinary HTTP input"}}
record("turn")
barrier("release-init")
mode = Path("claude-mode").read_text()
observed = str(uuid.uuid4()) if mode == "wrong-init" else native
emit({"type": "system", "subtype": "init", "session_id": observed})
record("init-emitted")
emit({"type": "assistant", "session_id": native, "uuid": str(uuid.uuid4()),
      "user_message_uuid": input_uuid, "message": {"role": "assistant",
      "content": [{"type": "text", "text": "Synthetic Claude progress"}]}})
barrier("release-result")
emit({"type": "result", "session_id": native, "subtype": "success",
      "uuid": str(uuid.uuid4()), "user_message_uuid": input_uuid,
      "is_error": False, "result": "Synthetic Claude progress"})
record("result")
assert not sys.stdin.read(), "completed first-turn fixture must not receive more input"
