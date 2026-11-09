"""Closed local control protocol. No provider content, paths or credentials."""
import json
import struct
import unicodedata
import uuid

VERSION = 1
MAX_FRAME = 8192
HEADER = struct.Struct("!I")
LIFETIME_SECONDS = 900
# An active window may be extended by its opener up to this total lifetime.
MAX_LIFETIME_SECONDS = 14400
DRAIN_SECONDS = 30
MAX_ATTEMPTS = 32
DRAIN_ATTEMPTS = 4
MAX_BYTES = 64 * 1024**2
DRAIN_BYTES = 1024**2
CREDIT_BYTES = 16 * 1024
MAX_BIND_MS = 5000
# Independent root ceiling on concurrently live windows (all conversations).
# Runtime's configured capacity stays below it: Core closes a window before
# this manager records retirement, so the ceiling keeps that ordering slack.
MAX_LIVE_WINDOWS = 16
BIND_REPLY_SECONDS = 0.1
# Core's audited decision for a window whose opener is gone. Never a grant.
# "failed": the open failed before the window ran anything; it names no run.
RECONCILED_OUTCOMES = ("accepted", "stopped", "abandoned", "failed")


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
        value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=unique,
                          parse_constant=lambda _value: (_ for _ in ()).throw(Refused("json_number")))
        canonical(value)  # Reject unpaired escaped surrogates, not only raw UTF-8 errors.
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("json") from None
    require(type(value) is dict, "object_required")
    common = {"version", "operation", "request_id", "owner_id", "conversation_id"}
    operation = value.get("operation")
    fields = {
        "status": set(),
        "workspace_attest": {"project_id"},
        "workspace_command": {"window_id","generation","capability"},
        "workspace_command_receipt": {"window_id","generation","operation_id","source_sha256"},
        "workspace_command_cancel": {"window_id","generation","operation_id","source_sha256"},
        "managed_pending": {"window_id","generation"},
        "managed_run_open": {"window_id","generation","run"},
        "managed_run_close": {"window_id","generation","run_id"},
        "managed_consume": {"window_id","generation","capability"},
        "managed_renew": {"window_id","generation","capability"},
        "managed_result": {"window_id","generation","result"},
        "managed_worker_reply": {"window_id","generation","result"},
        "managed_worker_bind": {"window_id","generation","result"},
        "managed_poll": {"window_id","generation","operation_id"},
        "managed_cancel": {"window_id","generation","operation_id"},
        "desk_login": {"window_id","generation","capability"},
        "desk_login_poll": {"window_id","generation","operation_id"},
        "desk_login_cancel": {"window_id","generation","operation_id"},
        "admit": {"window_id", "generation", "expected_generation", "input_message_id",
                  "input_event_id", "input_request_key", "predecessor_window_id",
                  "opened_at_ms", "work_deadline_ms", "expires_at_ms"},
        "drain": {"window_id", "generation"},
        "launch_child": {"window_id", "generation", "role", "mode", "setup", "preferences", "proxy_pid", "proxy_start", "bind_deadline_ms"},
        "bind_child": {"window_id", "generation", "broker_pid", "broker_start", "bind_deadline_ms"},
        "retire": {"window_id", "generation", "outcome", "run_id", "terminal_event_id"},
        "reconcile": {"window_id", "generation", "outcome", "run_id", "terminal_event_id"},
        "uncertain": {"window_id", "generation", "reason"},
        "extend": {"window_id", "generation", "expires_at_ms"},
    }
    require(type(operation) is str and operation in fields, "operation")
    optional = {'workspace_worker'} if operation == 'launch_child' else set()
    require(common | fields[operation] <= set(value) <= common | fields[operation] | optional, "fields")
    require(type(value["version"]) is int and value["version"] == VERSION, "version")
    key(value["request_id"])
    # A failed open has no run of its own: both run fields are exactly null.
    # A window whose last Deep turn lapsed is also `failed`, naming that turn.
    runless = (operation == "reconcile" and value.get("outcome") == "failed"
               and value.get("run_id") is None)
    if runless:
        require(value["terminal_event_id"] is None, "terminal_run")
    for field in ("owner_id", "conversation_id", "project_id", "window_id", "input_message_id", "input_event_id", "run_id", "terminal_event_id"):
        if field in value and not (runless and field in ("run_id", "terminal_event_id")):
            identifier(value[field])
    for field in ("generation", "expected_generation"):
        if field in value:
            generation(value[field])
    if operation == "admit":
        for field in ("opened_at_ms", "work_deadline_ms", "expires_at_ms"):
            require(type(value[field]) is int and 0 <= value[field] < 2**53, "timestamp")
        require(type(value["input_request_key"]) is str and 0 < len(value["input_request_key"].encode()) <= 128
                and not any(unicodedata.category(c) == "Cc" for c in value["input_request_key"]), "input_request_key")
        if value["predecessor_window_id"] is not None:
            identifier(value["predecessor_window_id"])
        require(value["expires_at_ms"] == value["opened_at_ms"] + LIFETIME_SECONDS * 1000 and
                value["work_deadline_ms"] == value["expires_at_ms"] - DRAIN_SECONDS * 1000,
                "window_deadlines")
    if operation == "retire":
        require(value["outcome"] in ("accepted", "stopped"), "terminal_outcome")
    if operation == "reconcile":
        require(value["outcome"] in RECONCILED_OUTCOMES, "terminal_outcome")
    if operation == "launch_child":
        require(type(value.get('workspace_worker', False)) is bool and (not value.get('workspace_worker', False) or
                type(value['role']) is str and value['role'].startswith('worker-') and value['mode']=='fresh'), 'workspace_worker_launch')
        setup_scope(value['setup'],value['role'],value['owner_id'],value['conversation_id'])
        preferences(value['preferences'],value['role'])
        require(type(value["proxy_pid"]) is int and 1 < value["proxy_pid"] < 2**31 and
                type(value["proxy_start"]) is int and 0 < value["proxy_start"] < 2**53, "proxy_locator")
        require(value["role"] in ("deep", "fast", "claude", "worker-0", "worker-1", "worker-2", "worker-3")
                and value["mode"] in ("fresh", "resume")
                and (value["mode"] == "resume") == ('native_session_id' in value['setup']), "launch_mode")
        require(type(value["bind_deadline_ms"]) is int and 0 < value["bind_deadline_ms"] < 2**53,
                "bind_deadline")
    if operation=='desk_login':
        from .desk_operations import capability
        capability(value['capability'])
    if operation=='workspace_command':
        from .workspace_command import capability
        capability(value['capability'])
    if operation in ('workspace_command_receipt','workspace_command_cancel'):
        identifier(value['operation_id'])
        require(type(value['source_sha256']) is str and len(value['source_sha256'])==64 and
                all(c in '0123456789abcdef' for c in value['source_sha256']), 'workspace_command_digest')
    if operation in ('managed_consume','managed_renew'):
        from .managed_control import capability
        capability(value['capability'])
    if operation=='managed_result':
        from .managed_control import result_capability
        result_capability(value['result'])
    if operation in ('managed_poll','managed_cancel'):identifier(value['operation_id'])
    if operation in ('desk_login_poll','desk_login_cancel'):identifier(value['operation_id'])
    if operation == "bind_child":
        require(type(value["broker_pid"]) is int and 1 < value["broker_pid"] < 2**31,
                "broker_pid")
        require(type(value["broker_start"]) is int and 0 < value["broker_start"] < 2**53,
                "broker_start")
        require(type(value["bind_deadline_ms"]) is int and 0 < value["bind_deadline_ms"] < 2**53,
                "bind_deadline")
    if operation == "extend":
        require(type(value["expires_at_ms"]) is int and 0 < value["expires_at_ms"] < 2**53, "timestamp")
    if operation == "uncertain":
        require(value["reason"] in ("runtime_refused", "auth_revoked", "cleanup_unknown", "server_lost"),
                "uncertainty_reason")
    return value


def setup_scope(value,launcher,owner,conversation):
    require(type(launcher) is str and launcher in ('deep','fast','claude','worker-0','worker-1','worker-2','worker-3'),
            'setup_launcher')
    fields={'owner_id','conversation_id','session_id','generation','incarnation','provider','role'}
    require(type(value) is dict and set(value) in (fields, fields|{'native_session_id','resume_setup_id'}),
            'setup_fields')
    require(value['owner_id']==owner and value['conversation_id']==conversation,'setup_owner_scope')
    identifier(value['session_id']);generation(value['generation']);key(value['incarnation'])
    expected=(value['provider']=='claude' and value['role'] in ('deep','fast')) if launcher=='claude' else (
        value['provider']=='codex' and value['role']==('worker' if launcher.startswith('worker-') else launcher))
    require(expected,'setup_role')
    if 'native_session_id' in value:
        identifier(value['resume_setup_id'])
        native=value['native_session_id']
        require(value['role'] in ('deep','fast') and type(native) is str and
                0<len(native.encode())<=512 and not any(unicodedata.category(c)=='Cc' for c in native),
                'setup_resume_scope')
        if value['provider']=='claude':identifier(native)


def preferences(value,launcher):
    require(type(value) is dict and set(value)=={'model','effort'},'launch_preferences')
    model,effort=value['model'],value['effort']
    require(model is None or type(model) is str and 0<len(model)<=120 and not model.isdigit() and
            all(c.isascii() and (c.isalnum() or c in '._:-') for c in model),'launch_model')
    require(effort is None or effort in ('low','medium','high','max'),'launch_effort')
    require(launcher=='claude' or model is None and effort is None,'launch_preference_role')


def canonical(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8", "strict")
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("json") from None


def encode(value):
    raw = canonical(value)
    require(len(raw) <= MAX_FRAME, "frame_bound")
    return HEADER.pack(len(raw)) + raw
