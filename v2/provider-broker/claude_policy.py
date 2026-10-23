"""Closed native policy-refusal evidence, never an input or terminal proof."""
import re
from protocol import require
from claude_control import canonical


def reported_model(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", value) else None


def refusal(channel, frame):
    synthetic = (frame.get("type") == "user" and frame.get("isSynthetic") is True
                 and "refused_message_id" in frame)
    fallback = frame.get("type") == "system" and frame.get("subtype") == "model_refusal_fallback"
    if not synthetic and not fallback:
        return None
    require(channel.initialized and channel.system_seen and channel.active is not None
            and channel.input_uuid is not None and not channel.terminal
            and frame.get("parent_tool_use_id") is None and "sessionId" not in frame)
    if synthetic:
        canonical(frame.get("uuid"))
        message = frame.get("message")
        reference = frame["refused_message_id"]
        require(isinstance(message, dict) and message.get("role") == "user"
                and isinstance(reference, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", reference))
    else:
        if "refused_user_message_uuid" in frame:
            require(canonical(frame["refused_user_message_uuid"]) == channel.input_uuid)
    # Discard the synthetic retry text, category/explanation and replacement model.
    # No subsequent fallback answer can become a proposal on this channel.
    model = reported_model(frame.get("original_model")) or channel.current_model or channel.resolved_model
    channel.policy_refused = True
    clean = {"type": "system", "subtype": "provider_policy_refusal",
             "session_id": channel.native, "user_message_uuid": channel.input_uuid}
    if model is not None:
        clean["model"] = model
    return {"method": "BrokerOutput", "params": {"owned_handle": channel.handle,
            "request_id": channel.active, "frame": clean}}
