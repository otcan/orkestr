"""Creating a new binding over the loopback API (`PUT /bindings/<remote>`).

The Rust server's "New WhatsApp chat" uses this to wire a freshly created V1
group thread to its V2 conversation without an operator writing files. It can
only add a binding: an existing file is never changed (an identical request is
idempotent), and a document that collides with another binding's identity is
removed again and refused, so an incumbent binding is never disturbed.
Pausing, revoking or editing a binding stays an operator file edit.
"""
import json
import os
from pathlib import Path

from . import config as config_module


def _write_private(path, value):
    data = json.dumps(value, indent=1, sort_keys=True).encode()
    temporary = path.with_name("." + path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)  # Fails if another request created it first.
    finally:
        temporary.unlink(missing_ok=True)


def create(registry, service, remote, document):
    """(status, body) for one creation request."""
    directory = service.get("bindings_dir")
    if not directory:
        return 409, {"ok": False, "error": "bindings_dir_unconfigured"}
    if not isinstance(document, dict) or document.get("remote_thread_id") != remote:
        return 400, {"ok": False, "error": "binding_identity"}
    try:
        config_module.binding(document, service["expected_owner"])
    except (ValueError, TypeError, KeyError) as error:
        return 400, {"ok": False, "error": str(error) or "binding_invalid"}
    path = Path(directory) / (remote + ".json")
    with registry._lock:
        if path.exists():
            try:
                current = config_module.private_json(path)
            except (ValueError, OSError):
                return 409, {"ok": False, "error": "binding_exists"}
            if current != document:
                return 409, {"ok": False, "error": "binding_exists"}
        else:
            try:
                _write_private(path, document)
            except FileExistsError:
                return 409, {"ok": False, "error": "binding_exists"}
        registry.reload()
        if registry.file_errors.get(str(path)) == "binding_conflict":
            path.unlink(missing_ok=True)
            registry.reload()
            return 409, {"ok": False, "error": "binding_conflict"}
        binding = registry.get(remote)
        if binding is None:
            return 409, {"ok": False, "error": registry.file_errors.get(str(path), "binding_refused")}
        return 200, {"ok": True, "remote_thread_id": remote, "state": binding.state, "error": binding.error}
