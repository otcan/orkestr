#!/usr/bin/python3
"""Fixed resumable synthetic native. Its transcript contains fixture data only."""
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
          "--mcp-config", '{"mcpServers":{}}', "--setting-sources", ""]
assert sys.argv[1:-2] == prefix
assert sys.argv[-2] in ("--session-id", "--resume")
resumed = sys.argv[-2] == "--resume"
native = str(uuid.UUID(sys.argv[-1]))
assert set(os.environ) == {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "PWD"}
assert os.environ["PWD"] == os.getcwd()
transcript = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "synthetic-transcript.json"
prior = json.loads(transcript.read_text()) if resumed else []
assert bool(prior) == resumed
assert not resumed or all(row["native"] == native for row in prior)
number = len(prior) + 1
mode = Path("claude-mode").read_text()


def record(kind, **fields):
    with Path("synthetic-peer.jsonl").open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(), "native": native,
            "number": number, "resumed": resumed,
            "pid_namespace": Path("/proc/self/ns/pid").stat().st_ino,
            "process_start": int(Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19]),
            **fields}) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


def barrier(name):
    deadline = time.monotonic() + 15
    while not Path(f"{name}-{number}").exists():
        assert time.monotonic() < deadline, "synthetic lifecycle barrier timed out"
        time.sleep(0.005)


record("spawn")
barrier("host-observed")
frame = json.loads(sys.stdin.readline())
assert frame == {"type": "control_request", "request_id": "initialize:2",
                 "request": {"subtype": "initialize", "hooks": None}}
emit({"type": "control_response", "response": {"subtype": "success",
      "request_id": frame["request_id"], "response": {}, "pending_permission_requests": []}})
record("initialized")
frame = json.loads(sys.stdin.readline())
input_uuid = frame.pop("uuid", None)
assert input_uuid == str(uuid.UUID(input_uuid))
expected = "synthetic ordinary HTTP input" + (f" {number}" if number > 1 else "")
assert frame == {"type": "user", "session_id": native, "parent_tool_use_id": None,
                 "message": {"role": "user", "content": expected}}
record("turn", input_uuid=input_uuid, prior_count=len(prior))
barrier("release-init")
emit({"type": "system", "subtype": "init", "session_id": native})
record("init-emitted")
correlation = {"user_message_uuid": input_uuid}
if resumed and mode == "stale-output":
    correlation["user_message_uuid"] = str(uuid.uuid4())
text = f"Synthetic Claude turn {number}, prior turns {len(prior)}"
emit({"type": "assistant", "session_id": native, "uuid": str(uuid.uuid4()), "message": {"role": "assistant",
      "content": [{"type": "text", "text": text}]}, **correlation})
barrier("release-result")
transcript.write_text(json.dumps(prior + [{"native": native, "input": input_uuid, "text": expected}]))
emit({"type": "result", "session_id": native, "subtype": "success", "uuid": str(uuid.uuid4()),
      "is_error": False, "result": text, **correlation})
record("result")
assert not sys.stdin.read(), "accepted continuation must use a new owned child"
