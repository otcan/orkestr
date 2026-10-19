"""Closed local control protocol. No provider content, paths or credentials."""
import json
import struct
import uuid

VERSION = 1
MAX_FRAME = 8192
HEADER = struct.Struct("!I")
LIFETIME_SECONDS = 900
DRAIN_SECONDS = 30
MAX_ATTEMPTS = 32
DRAIN_ATTEMPTS = 4
MAX_BYTES = 64 * 1024**2
DRAIN_BYTES = 1024**2
CREDIT_BYTES = 16 * 1024


class Refused(Exception):
    """Only fixed local categories may leave this trust boundary."""


def require(value, reason):
    if not value:
        raise Refused(reason)


def identifier(value):
    require(type(value) is str and len(value) == 36, "identifier")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise Refused("identifier") from None
    require(parsed.int != 0 and str(parsed) == value, "identifier")
    return value


def generation(value):
    require(type(value) is int and 0 <= value < 2**53, "generation")
    return value


def key(value):
    require(type(value) is str and 0 < len(value) <= 128 and
            all(c.isascii() and (c.isalnum() or c in "-_.:") for c in value), "request_key")
    return value


def unique(items):
    result = {}
    for key, value in items:
        require(key not in result, "duplicate_key")
        result[key] = value
    return result


def decode(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_FRAME, "frame_bound")
    try:
        value = json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _value: (_ for _ in ()).throw(Refused("json_number")))
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("json") from None
    require(type(value) is dict, "object_required")
    common = {"version", "operation", "request_id", "owner_id", "conversation_id"}
    operation = value.get("operation")
    fields = {
        "status": set(),
        "admit": {"window_id", "generation", "expected_generation", "input_message_id",
                  "input_event_id", "input_request_key", "predecessor_window_id",
                  "opened_at_ms", "work_deadline_ms", "expires_at_ms"},
        "drain": {"window_id", "generation"},
        "retire": {"window_id", "generation", "outcome", "run_id", "terminal_event_id"},
        "uncertain": {"window_id", "generation", "reason"},
    }
    require(type(operation) is str and operation in fields, "operation")
    require(set(value) == common | fields[operation], "fields")
    require(type(value["version"]) is int and value["version"] == VERSION, "version")
    key(value["request_id"])
    for field in ("owner_id", "conversation_id", "window_id", "input_message_id", "input_event_id", "run_id", "terminal_event_id"):
        if field in value:
            identifier(value[field])
    for field in ("generation", "expected_generation", "opened_at_ms", "work_deadline_ms", "expires_at_ms"):
        if field in value:
            generation(value[field])
    if operation == "admit":
        require(type(value["input_request_key"]) is str and 0 < len(value["input_request_key"].encode()) <= 128
                and not any(ord(c) < 32 or ord(c) == 127 for c in value["input_request_key"]), "input_request_key")
        if value["predecessor_window_id"] is not None:
            identifier(value["predecessor_window_id"])
        require(value["expires_at_ms"] == value["opened_at_ms"] + LIFETIME_SECONDS * 1000 and
                value["work_deadline_ms"] == value["expires_at_ms"] - DRAIN_SECONDS * 1000,
                "window_deadlines")
    if operation == "retire":
        require(value["outcome"] in ("accepted", "stopped"), "terminal_outcome")
    if operation == "uncertain":
        require(value["reason"] in ("runtime_refused", "auth_revoked", "cleanup_unknown", "server_lost"),
                "uncertainty_reason")
    return value


def encode(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    require(len(raw) <= MAX_FRAME, "frame_bound")
    return HEADER.pack(len(raw)) + raw
