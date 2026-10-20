"""Private configuration validation. Example values belong in operator config."""
import json
import os
from pathlib import Path
import stat
import uuid
from urllib.parse import urlsplit


def private_json(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("private_file_permissions")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("private_file_shape")
    return value


def load(path):
    value = private_json(path)
    required = {"origin", "loopback_url", "credentials_path", "expected_owner", "conversation_id", "expected_source",
                "public_thread_id", "chat_id", "account_id", "remote_thread_id", "token_path", "ledger_path",
                "listen_port", "excluded_public_ids", "allowed_principals", "automatic_accept_roles", "outbound_role", "enabled"}
    if set(value) != required:
        raise ValueError("config_fields")
    for key in ("expected_owner", "conversation_id", "remote_thread_id"):
        uuid.UUID(value[key])
    for key in ("origin", "loopback_url"):
        url = urlsplit(value[key])
        if url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
            raise ValueError("config_url")
        if key == "origin" and url.scheme != "https":
            raise ValueError("config_origin")
        if key == "loopback_url" and (url.scheme != "http" or url.hostname != "127.0.0.1"):
            raise ValueError("config_loopback")
    if not isinstance(value["listen_port"], int) or not 1024 <= value["listen_port"] <= 65535:
        raise ValueError("config_port")
    if value["automatic_accept_roles"] != ["fast", "deep"] or value["outbound_role"] != "deep":
        raise ValueError("config_accept_policy")
    if not isinstance(value["enabled"], bool) or not isinstance(value["excluded_public_ids"], list):
        raise ValueError("config_activation")
    if not isinstance(value["allowed_principals"], list) or not value["allowed_principals"] or not all(isinstance(x, str) and x for x in value["allowed_principals"]):
        raise ValueError("config_principals")
    token = private_json(value["token_path"]).get("token")
    if not isinstance(token, str) or len(token) < 32 or len(token) > 256 or not token.isascii() or not token.isalnum():
        raise ValueError("config_token")
    value["token"] = token
    return value
