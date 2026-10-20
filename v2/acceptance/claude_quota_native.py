#!/usr/bin/python3
"""Synthetic native: installed Claude CLI (2.1.x) rate-limit rejection frame shapes.

Used only by claude_provider_qualification.py; values are fake."""
import json, sys, uuid
native = sys.argv[-1]
def emit(v): print(json.dumps(v), flush=True)
init = json.loads(sys.stdin.readline())
emit({"type": "control_response", "response": {"subtype": "success", "request_id": init["request_id"], "response": {"commands": []}}})
user = json.loads(sys.stdin.readline()); msg = user["uuid"]
emit({"type": "command_lifecycle", "command_uuid": msg, "state": "queued", "uuid": str(uuid.uuid4()), "session_id": native})
emit({"type": "command_lifecycle", "command_uuid": msg, "state": "started", "uuid": str(uuid.uuid4()), "session_id": native})
emit({"type": "system", "subtype": "init", "session_id": native, "uuid": str(uuid.uuid4()), "tools": [], "model": "synthetic"})
emit({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 1792510200, "rateLimitType": "five_hour",
      "overageStatus": "rejected", "overageDisabledReason": "org_level_disabled", "isUsingOverage": False},
      "uuid": str(uuid.uuid4()), "session_id": native})
emit({"type": "assistant", "error": "rate_limit", "is_api_error_message": True, "timestamp": "2026-10-20T00:00:00.000Z",
      "message": {"id": str(uuid.uuid4()), "model": "<synthetic>", "role": "assistant", "type": "message", "content": [{"type": "text", "text": "You've hit your limit"}]},
      "parent_tool_use_id": None, "session_id": native, "uuid": str(uuid.uuid4()), "user_message_uuid": msg, "user_message_uuids": [msg]})
emit({"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your limit", "terminal_reason": "api_error",
      "session_id": native, "uuid": str(uuid.uuid4()), "user_message_uuid": msg, "user_message_uuids": [msg]})
sys.stdin.read()
