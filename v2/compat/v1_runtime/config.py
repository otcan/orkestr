"""Private configuration validation. Example values belong in operator config."""
import json
import os
from pathlib import Path
import re
import stat
import uuid
from urllib.parse import urlsplit

from . import instructions

SERVICE_FIELDS = {"origin", "loopback_url", "credentials_path", "expected_owner", "expected_source",
                  "token_path", "listen_port", "bindings_dir", "ledger_dir"}
SCOPE_FIELDS = {"conversation_id", "public_thread_id", "chat_id", "account_id", "remote_thread_id",
                "allowed_principals", "excluded_public_ids", "automatic_accept_roles", "outbound_role"}
BINDING_FIELDS = SCOPE_FIELDS | {"enabled", "revoked", "progress_updates", "attachments", "max_outstanding_inputs"}
# Optional binding fields and their defaults.
OPTIONAL_BINDING_FIELDS = {"max_input_age_seconds": 30 * 60, "participants": [], "owner_label": "Owner",
                           "instructions_path": None, "fast_reply_policy": "legacy",
                           "auto_steer": None, "owner_only_verified": False}
# Group participants other than the owner. The owner is only ever the verified
# `allowed_principals`; a participant can never hold the owner role.
PARTICIPANT_ROLES = ("member", "none")
PARTICIPANT_FIELDS = {"ids", "label", "role"}
MAX_PARTICIPANTS = 64
MAX_PARTICIPANT_IDS = 8
WHATSAPP_ID = re.compile(r"^[0-9]{5,24}@(?:c\.us|lid|s\.whatsapp\.net)$")
MAX_INPUT_AGE_RANGE = (60, 7 * 24 * 60 * 60)
# The single-chat pilot file: service and one binding in one document.
PILOT_FIELDS = (SERVICE_FIELDS - {"bindings_dir", "ledger_dir"}) | SCOPE_FIELDS | {"ledger_path", "enabled"}
# Ledger identity keys. Identical to the pilot so its ledger can be adopted in place.
LEDGER_SCOPE_KEYS = ("expected_owner", "conversation_id", "public_thread_id", "chat_id", "account_id", "remote_thread_id",
                     "allowed_principals", "excluded_public_ids", "automatic_accept_roles", "outbound_role")


def private_json(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("private_file_permissions")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("private_file_shape")
    return value


def private_directory(path):
    path = Path(path)
    info = path.lstat()
    if not path.is_absolute() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("private_directory_permissions")
    return str(path)


def _service(value):
    for key in ("origin", "loopback_url"):
        url = urlsplit(value[key])
        if url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
            raise ValueError("config_url")
        if key == "origin" and url.scheme != "https":
            raise ValueError("config_origin")
        if key == "loopback_url" and (url.scheme != "http" or url.hostname != "127.0.0.1"):
            raise ValueError("config_loopback")
    uuid.UUID(value["expected_owner"])
    if not isinstance(value["listen_port"], int) or not 1024 <= value["listen_port"] <= 65535:
        raise ValueError("config_port")
    token = private_json(value["token_path"]).get("token")
    if not isinstance(token, str) or len(token) < 32 or len(token) > 256 or not token.isascii() or not token.isalnum():
        raise ValueError("config_token")
    value["token"] = token
    return value


def label(value):
    """A display name: 1-64 printable characters, no line breaks or colons."""
    if (not isinstance(value, str) or not 1 <= len(value) <= 64 or value != value.strip() or ":" in value or
            not value.isprintable()):
        raise ValueError("config_participant_label")
    return value


def participants(value, owner_principals):
    """Explicit per-binding participant policy: [{ids, label, role}].

    `ids` are the WhatsApp phone JIDs and/or LIDs of one person. Only role
    `member` may instruct the thread; `none` keeps the entry but refuses it.
    """
    if not isinstance(value, list) or len(value) > MAX_PARTICIPANTS:
        raise ValueError("config_participants")
    seen_ids, seen_labels = set(owner_principals), set()
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != PARTICIPANT_FIELDS:
            raise ValueError("config_participants")
        ids = entry["ids"]
        if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_PARTICIPANT_IDS or
                not all(isinstance(x, str) and WHATSAPP_ID.match(x) for x in ids)):
            raise ValueError("config_participant_ids")
        if seen_ids & set(ids) or len(set(ids)) != len(ids):
            # An owner alias or another person's id: never two roles for one id.
            raise ValueError("config_participant_conflict")
        seen_ids |= set(ids)
        if entry["role"] not in PARTICIPANT_ROLES:
            raise ValueError("config_participant_role")
        if label(entry["label"]).casefold() in seen_labels:
            raise ValueError("config_participant_label")
        seen_labels.add(entry["label"].casefold())
    return value


def binding(value, owner):
    """Validate one binding document; returns it with its pinned ledger scope."""
    if not isinstance(value, dict) or set(value) - set(OPTIONAL_BINDING_FIELDS) != BINDING_FIELDS:
        raise ValueError("binding_fields")
    value = dict(OPTIONAL_BINDING_FIELDS, **value)
    if value["fast_reply_policy"] not in ("owner_only", "legacy", "disabled"):
        raise ValueError("config_fast_reply_policy")
    # None: on (question mode) for an owner-only group, off with members.
    if value["auto_steer"] not in (None, "off", "question", "running"):
        raise ValueError("config_auto_steer")
    age = value["max_input_age_seconds"]
    if type(age) is not int or not MAX_INPUT_AGE_RANGE[0] <= age <= MAX_INPUT_AGE_RANGE[1]:
        raise ValueError("config_input_age")
    for key in ("conversation_id", "remote_thread_id"):
        if str(uuid.UUID(value[key])) != value[key]:
            raise ValueError("binding_identity")
    for key in ("public_thread_id", "chat_id", "account_id"):
        if not isinstance(value[key], str) or not 1 <= len(value[key]) <= 256:
            raise ValueError("binding_scope")
    if value["automatic_accept_roles"] != ["fast", "deep"] or value["outbound_role"] != "deep":
        raise ValueError("config_accept_policy")
    for key in ("enabled", "revoked", "progress_updates", "attachments", "owner_only_verified"):
        if not isinstance(value[key], bool):
            raise ValueError("config_activation")
    if not isinstance(value["excluded_public_ids"], list) or not all(isinstance(x, str) for x in value["excluded_public_ids"]):
        raise ValueError("config_activation")
    if not isinstance(value["allowed_principals"], list) or not value["allowed_principals"] or not all(isinstance(x, str) and x for x in value["allowed_principals"]):
        raise ValueError("config_principals")
    if type(value["max_outstanding_inputs"]) is not int or not 1 <= value["max_outstanding_inputs"] <= 64:
        raise ValueError("config_capacity")
    participants(value["participants"], value["allowed_principals"])
    label(value["owner_label"])
    instructions.check_path(value["instructions_path"])
    if value["owner_label"].casefold() in {p["label"].casefold() for p in value["participants"]}:
        raise ValueError("config_participant_label")
    value = dict(value)
    value["scope"] = {key: owner if key == "expected_owner" else value[key] for key in LEDGER_SCOPE_KEYS}
    return value


def load(path):
    """Returns (service, static_bindings). A pilot file yields one static binding."""
    value = private_json(path)
    if set(value) == PILOT_FIELDS:
        service = _service({k: value[k] for k in PILOT_FIELDS - SCOPE_FIELDS - {"ledger_path", "enabled"}})
        pinned = {k: value[k] for k in SCOPE_FIELDS}
        # Pilot defaults: no progress or attachments; the pilot's 32-input bound.
        pinned.update(enabled=value["enabled"], revoked=False, progress_updates=False, attachments=False,
                      max_outstanding_inputs=32)
        static = binding(pinned, value["expected_owner"])
        static["ledger_path"] = value["ledger_path"]
        service.update(bindings_dir=None, ledger_dir=None)
        return service, [static]
    if set(value) != SERVICE_FIELDS:
        raise ValueError("config_fields")
    service = _service(value)
    service["bindings_dir"] = private_directory(value["bindings_dir"])
    service["ledger_dir"] = private_directory(value["ledger_dir"])
    return service, []
