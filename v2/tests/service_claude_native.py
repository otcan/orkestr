#!/usr/bin/python3
"""Fixed synthetic Claude stream-json native for window fixtures; no provider."""
import json
import os
from pathlib import Path
import sys
import uuid

FULL_ACCESS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
               "--verbose", "--dangerously-skip-permissions", "--no-chrome",
               "--prompt-suggestions", "false"]
assert sys.argv[1:-2] == FULL_ACCESS, sys.argv
mode, native = sys.argv[-2], str(uuid.UUID(sys.argv[-1]))
assert mode in ("--session-id", "--resume")
assert os.environ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] == "1"
assert not {"ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"} & set(os.environ)
state = Path(os.environ["CLAUDE_CONFIG_DIR"]) / (native + ".turns")
assert state.exists() == (mode == "--resume"), "resume requires the prior native session"
turns = int(state.read_text()) if state.exists() else 0


def record(kind, **fields):
    with Path("claude-peer.jsonl").open("a") as stream:
        stream.write(json.dumps({"kind": kind, "pid": os.getpid(), "native": native,
                                 "resumed": mode == "--resume", **fields}) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


record("spawn", model=os.environ.get("ANTHROPIC_MODEL"),
       effort=os.environ.get("CLAUDE_CODE_EFFORT_LEVEL"))
setup = json.loads(sys.stdin.readline())
assert setup["request"] == {"subtype": "initialize", "hooks": None}
emit({"type": "control_response", "response": {"subtype": "success",
      "request_id": setup["request_id"], "response": {}}})
emit({"type": "system", "subtype": "commands_changed", "session_id": native,
      "uuid": str(uuid.uuid4()), "commands": [{"name": "synthetic-command",
      "description": "synthetic installed command description " * 12,
      "argumentHint": "", "aliases": []} for _ in range(80)]})
frame = json.loads(sys.stdin.readline())
assert frame["type"] == "user" and frame["session_id"] == native
message = frame["uuid"]
turns += 1
state.write_text(str(turns))
record("turn", number=turns, text=frame["message"]["content"])
emit({"type": "system", "subtype": "init", "session_id": native, "uuid": str(uuid.uuid4())})
if "hold" in frame["message"]["content"]:
    # Long synthetic turn: progress, then wait for the exact interrupt.
    emit({"type": "assistant", "session_id": native, "uuid": str(uuid.uuid4()),
          "parent_tool_use_id": None, "user_message_uuid": message,
          "message": {"id": "msg_held", "role": "assistant",
                      "content": [{"type": "text", "text": "synthetic held progress"}]}})
    control = json.loads(sys.stdin.readline())
    assert control["request"] == {"subtype": "interrupt", "cancel_queued": False,
                                  "for_user_message_uuids": [message]}, control
    record("interrupt")
    emit({"type": "control_response", "response": {"subtype": "success",
          "request_id": control["request_id"], "response": {"still_queued": [], "turn": "stopped"}}})
    emit({"type": "result", "subtype": "error_during_execution", "is_error": True,
          "terminal_reason": "aborted_streaming", "session_id": native,
          "uuid": str(uuid.uuid4()), "user_message_uuid": message})
    assert not sys.stdin.read()
    raise SystemExit(0)
emit({"type": "assistant", "session_id": native, "uuid": str(uuid.uuid4()),
      "parent_tool_use_id": None, "user_message_uuid": message,
      "message": {"id": "msg_synthetic", "role": "assistant",
                  "content": [{"type": "text", "text": f"synthetic Claude turn {turns}"}]}})
# Installed-CLI informational rate telemetry, including a field added after the
# closed codec was written (overageEnabled); it must drain, never lose the turn.
emit({"type": "rate_limit_event", "uuid": str(uuid.uuid4()), "session_id": native,
      "rate_limit_info": {"status": "allowed_warning", "resetsAt": 1, "rateLimitType": "seven_day",
                          "utilization": 0.3, "overageStatus": "rejected", "overageEnabled": False,
                          "isUsingOverage": False}})
if Path("fast-crash").exists() and "ANTHROPIC_MODEL" not in os.environ:
    record("fast-crash")
    os._exit(1)  # A lost Fast native: no terminal result, abrupt exit.
emit({"type": "result", "subtype": "success", "is_error": False, "session_id": native,
      "uuid": str(uuid.uuid4()), "user_message_uuid": message,
      "result": f"synthetic Claude turn {turns}"})
assert not sys.stdin.read(), "one input per native process"
