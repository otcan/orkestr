"""Binding registry: many independently managed bindings in one service.

Bindings are private JSON files in ``bindings_dir``. A rescan adds, pauses,
resumes or revokes one binding without touching any other. A binding whose
pinned scope changes, conflicts with another, or was revoked earlier is
refused and stopped; its ledger is never rewritten to fit the new file.
"""
import json
import os
from pathlib import Path
import sys
import threading
import time
import traceback

from . import config as config_module
from .export_changes import ExportChanges
from .ledger import Ledger
from .auto_steer import default_mode as auto_steer_mode
from .worker import DEFAULT_BURST_QUIET_S, Signal, Worker, attachment_export_settings

UNIQUE_KEYS = ("remote_thread_id", "conversation_id", "public_thread_id", "chat_id")
# A crashed binding worker is restarted after 1, 5 and 30 s, then every 60 s.
# A worker that ran WORKER_HEALTHY_S before crashing starts the ladder again.
WORKER_RESTART_S = (1, 5, 30, 60)
WORKER_HEALTHY_S = 300

MUTABLE_KEYS = ("enabled", "revoked", "progress_updates", "attachments", "max_outstanding_inputs", "max_input_age_seconds",
                "participants", "owner_label", "instructions_path", "fast_reply_policy", "auto_steer",
                "owner_only_verified", "deep_heartbeat")


class Binding:
    def __init__(self, source, value, ledger):
        self.source, self.config, self.ledger = source, value, ledger
        self.error = None
        # Stops the worker; `stop.wake()` makes it step a new input at once.
        self.stop = Signal()
        self.thread = self.worker = None
        # Supervisor view of the worker thread: "running", "restarting"
        # (backing off after a crash) or "stopped"; see Registry._supervise.
        self.worker_state = None
        self.crashes = 0
        self.last_crash = None

    def worker_status(self):
        """Liveness of this binding's worker; `alive` is what operators check."""
        thread = self.thread
        alive = bool(thread and thread.is_alive() and self.worker_state == "running")
        if thread is None:
            state = "absent"
        elif not thread.is_alive():
            state = "stopped" if self.stop.is_set() else "dead"
        else:
            state = self.worker_state or "starting"
        return {"alive": alive, "state": state, "crashes": self.crashes, "lastError": self.last_crash}

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


def scrubs_paths(config):
    """Whether replies in this binding's chat have server-local paths scrubbed.

    Every chat is scrubbed unless the operator marked the binding
    `owner_only_verified: true` (the WhatsApp group was checked to hold only
    the owner and the bot). `fast_reply_policy` alone does not establish that:
    a binding without the field is scrubbed. A listed participant (`member`
    or `none`; config refuses owner aliases as participants) is someone else
    reading the chat, so it is scrubbed even when marked verified."""
    return not (config.get("owner_only_verified") is True and not config.get("participants"))


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
        binding.worker.deep_heartbeat = binding.config.get("deep_heartbeat", True) is not False
        binding.worker.fast_reply_policy = binding.config["fast_reply_policy"]
        binding.ledger.owner_only = binding.config["fast_reply_policy"] == "owner_only"
        binding.ledger.scrub_paths = scrubs_paths(binding.config)
        binding.worker.auto_steer = auto_steer_mode(binding.config)
        binding.worker.attachments = binding.config["attachments"]
        binding.worker.max_input_age_s = binding.config["max_input_age_seconds"]
        binding.worker.instructions_path = binding.config["instructions_path"]
        if binding.thread is None and self.workers:
            binding.thread = threading.Thread(target=self._supervise, args=(binding,),
                                              daemon=True, name="binding-" + binding.remote_thread_id[:8])
            binding.thread.start()

    def _supervise(self, binding):
        """Run the binding's worker until the binding stops; never leave it dead.

        A worker that raises is alerted and restarted with backoff. Before
        this, one exception (an fd-exhausted ledger open at startup) ended the
        thread for good and that chat silently got no replies (2026-10-29)."""
        attempt = 0
        try:
            while not binding.stop.is_set():
                started = time.monotonic()
                binding.worker_state = "running"
                try:
                    binding.worker.run(binding.stop, lambda: binding.state == "enabled")
                    if binding.stop.is_set():
                        break
                    error_name = "WorkerExited"
                except Exception as error:
                    error_name = type(error).__name__
                    # Frame locations only: an exception message (or a source
                    # line building one) may quote chat text.
                    stack = " <- ".join("%s:%d:%s" % (os.path.basename(frame.filename), frame.lineno, frame.name)
                                        for frame in reversed(traceback.extract_tb(error.__traceback__)))
                else:
                    stack = ""
                binding.crashes += 1
                binding.last_crash = error_name
                if time.monotonic() - started >= WORKER_HEALTHY_S:
                    attempt = 0
                delay = WORKER_RESTART_S[min(attempt, len(WORKER_RESTART_S) - 1)]
                attempt += 1
                binding.worker_state = "restarting"
                print("ALERT orkestr-v2-wa-adapter worker_crashed binding=%s error=%s crashes=%d restart_in_s=%g"
                      % (binding.remote_thread_id, error_name, binding.crashes, delay), file=sys.stderr, flush=True)
                if stack:
                    print("orkestr-v2-wa-adapter worker_crashed binding=%s at %s" % (binding.remote_thread_id, stack),
                          file=sys.stderr, flush=True)
                # A new input wakes the stop signal; that must not cut the backoff short.
                deadline = time.monotonic() + delay
                while not binding.stop.is_set() and time.monotonic() < deadline:
                    binding.stop.wait(deadline - time.monotonic())
        finally:
            binding.worker_state = "stopped"

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
        with self._lock:
            return self._status()

    def _status(self):
        states = [b.state for b in self.bindings.values()]
        sources = {b.source for b in self.bindings.values()}
        unloaded = [source for source in self.file_errors if source not in sources]
        workers = {b.remote_thread_id: b.worker_status() for b in self.bindings.values() if b.thread is not None}
        enabled = [r for r, b in self.bindings.items() if b.state == "enabled" and r in workers]
        return {"bindings": len(states), "enabled": states.count("enabled"), "disabled": states.count("disabled"),
                "revoked": states.count("revoked"), "refused": states.count("refused") + len(unloaded),
                # Worker liveness: `alive == expected` means every binding thread
                # is stepping; `notAlive` names the rest (dead or backing off).
                "workers": {"expected": len(workers), "alive": sum(w["alive"] for w in workers.values()),
                            "enabledAlive": sum(workers[r]["alive"] for r in enabled),
                            "crashes": sum(w["crashes"] for w in workers.values()),
                            "notAlive": sorted(r for r, w in workers.items() if not w["alive"])}}

    def run(self, stop, wake, interval=5):
        while not stop.is_set():
            wake.wait(interval)
            wake.clear()
            if not stop.is_set():
                self.reload()
