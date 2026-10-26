"""Binding registry: many independently managed bindings in one service.

Bindings are private JSON files in ``bindings_dir``. A rescan adds, pauses,
resumes or revokes one binding without touching any other. A binding whose
pinned scope changes, conflicts with another, or was revoked earlier is
refused and stopped; its ledger is never rewritten to fit the new file.
"""
import json
import os
from pathlib import Path
import threading

from . import config as config_module
from .export_changes import ExportChanges
from .ledger import Ledger
from .auto_steer import default_mode as auto_steer_mode
from .worker import DEFAULT_BURST_QUIET_S, Signal, Worker, attachment_export_settings

UNIQUE_KEYS = ("remote_thread_id", "conversation_id", "public_thread_id", "chat_id")
MUTABLE_KEYS = ("enabled", "revoked", "progress_updates", "attachments", "max_outstanding_inputs", "max_input_age_seconds",
                "participants", "owner_label", "instructions_path", "fast_reply_policy", "auto_steer")


class Binding:
    def __init__(self, source, value, ledger):
        self.source, self.config, self.ledger = source, value, ledger
        self.error = None
        # Stops the worker; `stop.wake()` makes it step a new input at once.
        self.stop = Signal()
        self.thread = self.worker = None

    @property
    def remote_thread_id(self):
        return self.config["remote_thread_id"]

    @property
    def state(self):
        if self.error:
            return "refused"
        if self.config["revoked"]:
            return "revoked"
        return "enabled" if self.config["enabled"] else "disabled"

    def identity(self):
        return json.dumps(self.config["scope"], sort_keys=True)


class Registry:
    def __init__(self, service, client_factory, static=(), workers=True):
        self.service, self.client_factory, self.workers = service, client_factory, workers
        self.static = list(static)
        self.changes = ExportChanges()
        self.bindings = {}
        self.file_errors = {}
        self._lock = threading.RLock()

    def get(self, remote_thread_id):
        with self._lock:
            return self.bindings.get(remote_thread_id)

    def _documents(self):
        """(source, value-or-error) for every binding document."""
        documents = [("static:%d" % i, value) for i, value in enumerate(self.static)]
        directory = self.service.get("bindings_dir")
        if directory:
            for path in sorted(Path(directory).iterdir()):
                if path.suffix != ".json" or path.name.startswith("."):
                    continue
                try:
                    value = config_module.binding(config_module.private_json(path), self.service["expected_owner"])
                    if path.stem != value["remote_thread_id"]:
                        raise ValueError("binding_filename")
                    documents.append((str(path), value))
                except (ValueError, OSError, TypeError, KeyError) as error:
                    documents.append((str(path), ValueError(str(error) or "binding_invalid")))
        return documents

    def _ledger_path(self, value):
        if value.get("ledger_path"):
            return value["ledger_path"]
        return os.path.join(self.service["ledger_dir"], value["remote_thread_id"] + ".sqlite3")

    def reload(self):
        with self._lock:
            documents = self._documents()
            self.file_errors = {source: str(value) for source, value in documents if isinstance(value, Exception)}
            valid = [(source, value) for source, value in documents if not isinstance(value, Exception)]
            # Refuse any binding that shares an identity with another document.
            # A binding already serving that identity keeps it; newcomers are refused.
            owners, conflicted = {}, set()
            for source, value in valid:
                for key in UNIQUE_KEYS:
                    owners.setdefault((key, value[key]), []).append(source)
            for (key, _), sources in owners.items():
                if len(sources) > 1:
                    keep = [s for s in sources if any(b.source == s and not b.error for b in self.bindings.values())]
                    conflicted.update(s for s in sources if s not in keep[:1])
            seen = set()
            for source, value in valid:
                remote = value["remote_thread_id"]
                if source in conflicted:
                    self.file_errors[source] = "binding_conflict"
                    current = self.bindings.get(remote)
                    if current and current.source == source:
                        self._refuse(current, "binding_conflict")
                    continue
                seen.add(remote)
                self._apply(source, value)
            for remote in list(self.bindings):
                binding = self.bindings[remote]
                if remote in seen or binding.source in conflicted:
                    continue
                if binding.source in self.file_errors:
                    # A damaged file pauses its binding; it is not silently unloaded.
                    self._refuse(binding, "binding_file_invalid")
                else:
                    self._stop(self.bindings.pop(remote))
            return self.status()

    def _apply(self, source, value):
        remote = value["remote_thread_id"]
        current = self.bindings.get(remote)
        if current is None:
            try:
                ledger = Ledger(self._ledger_path(value), value["scope"], value["max_outstanding_inputs"],
                                on_export=lambda: self.changes.publish(remote))
            except (ValueError, OSError) as error:
                self.file_errors[source] = str(error)
                return
            current = self.bindings[remote] = Binding(source, value, ledger)
            self.changes.publish(remote)
            current.error = None
        elif current.identity() != json.dumps(value["scope"], sort_keys=True) or current.source != source:
            self._refuse(current, "binding_scope_changed")
            return
        elif current.error in ("binding_scope_changed", "binding_conflict", "binding_file_invalid"):
            current.error = None
        if current.error == "binding_revoked":
            return
        for key in MUTABLE_KEYS:
            current.config[key] = value[key]
        current.ledger.max_outstanding = value["max_outstanding_inputs"]
        if value["revoked"]:
            current.ledger.revoke()
        elif current.ledger.revoked():
            # Revocation is permanent for this route; re-enabling needs a new binding.
            self._refuse(current, "binding_revoked")
            return
        self._start(current)

    def _refuse(self, binding, reason):
        # The worker thread observes the state and stops stepping; nothing is deleted.
        binding.error = reason

    def _start(self, binding):
        if binding.worker is None:
            client = self.client_factory(binding.config["conversation_id"])
            directory, gid = attachment_export_settings()
            binding.worker = Worker(client, binding.ledger, attachment_dir=directory, attachment_gid=gid,
                                    burst_quiet_s=DEFAULT_BURST_QUIET_S)
        binding.worker.progress_updates = binding.config["progress_updates"]
        binding.worker.fast_reply_policy = binding.config["fast_reply_policy"]
        binding.ledger.owner_only = binding.config["fast_reply_policy"] == "owner_only"
        binding.worker.auto_steer = auto_steer_mode(binding.config)
        binding.worker.attachments = binding.config["attachments"]
        binding.worker.max_input_age_s = binding.config["max_input_age_seconds"]
        binding.worker.instructions_path = binding.config["instructions_path"]
        if binding.thread is None and self.workers:
            binding.thread = threading.Thread(target=binding.worker.run,
                                              args=(binding.stop, lambda: binding.state == "enabled"),
                                              daemon=True, name="binding-" + binding.remote_thread_id[:8])
            binding.thread.start()

    def _stop(self, binding, wait=False):
        binding.stop.set()
        if wait and binding.thread:
            binding.thread.join(timeout=10)

    def shutdown(self):
        self.changes.close()
        with self._lock:
            for binding in self.bindings.values():
                self._stop(binding, wait=True)

    def status(self):
        states = [b.state for b in self.bindings.values()]
        sources = {b.source for b in self.bindings.values()}
        unloaded = [source for source in self.file_errors if source not in sources]
        return {"bindings": len(states), "enabled": states.count("enabled"), "disabled": states.count("disabled"),
                "revoked": states.count("revoked"), "refused": states.count("refused") + len(unloaded)}

    def run(self, stop, wake, interval=5):
        while not stop.is_set():
            wake.wait(interval)
            wake.clear()
            if not stop.is_set():
                self.reload()
