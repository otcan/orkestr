"""Synthetic exact-source HTTP peer; no provider processes or transport sends."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.worker import Worker

from v2.compat.v1_runtime.rust_client import ClientError, RustClient
from v2.compat.v1_runtime.tests.test_worker import Peer


def identity(number):
    return str(uuid.UUID(int=number + 100))


class IntakePeer(Peer):
    owner, conversation = identity(1), identity(2)
    matching_run_ids = RustClient.matching_run_ids

    def __init__(self):
        super().__init__()
        self.inputs, self.events, self.runs, self.receipts = [], [], {}, {}
        self.revision = 1
        self.capacity = False
        self.before_accept = None
        self.texts = {}  # run id -> payload text override

    def read_events(self, after, maximum, timeout_s=None):
        return copy.deepcopy([event for event in self.events if event["sequence"] > after][:maximum])

    def event(self, intake, run, schema=5, observation=None):
        sequence = max([0] + [event["sequence"] for event in self.events]) + 1
        self.events.append(dict(sequence=sequence, owner_id=self.owner, aggregate_id=self.conversation,
            source_message_id=intake["message_id"], source_event_id=intake["event_id"], schema_version=schema,
            payload_ref_or_safe_payload=dict(kind="provider_observed", run_id=run, observation=observation)))
        return sequence

    def start(self, role):
        if any(run["role"] == role and run["phase"] != "completed" for run in self.runs.values()):
            return
        for index, intake in enumerate(self.inputs):
            if not intake.get("window") or (index, role) in self.runs:
                continue
            run = identity(1000 + index * 10 + (role == "deep"))
            self.runs[index, role] = dict(run_id=run, role=role,
                phase="running" if role == "deep" else "awaiting_acceptance",
                progress=dict(payload_id=run + "-payload"),
                acceptance_candidate=dict(run_id=run, completion_event_id=run + "-completion"))
            self.event(intake, run)
            return

    def request(self, method, route, body=None, allowed=(200,)):
        if method == "POST" and route == "/messages":
            self.mutations.append((route, copy.deepcopy(body)))
            for intake in self.inputs:
                if intake["key"] == body["client_message_id"]:
                    assert intake["text"] == body["text"]
                    return 200, {key: intake[key] for key in ("status", "message_id", "event_id", "sequence")}
            sequence = max([0] + [event["sequence"] for event in self.events]) + 1
            intake = dict(status="accepted", message_id=identity(100 + len(self.inputs) * 2),
                event_id=identity(101 + len(self.inputs) * 2), sequence=sequence,
                key=body["client_message_id"], text=body["text"])
            self.inputs.append(intake)
            self.events.append(dict(sequence=sequence, owner_id=self.owner, aggregate_id=self.conversation))
            self.revision += 1
            return 202, {key: intake[key] for key in ("status", "message_id", "event_id", "sequence")}
        if route == "/window" and method == "GET":
            return 204, None
        if route == "/window" and method == "POST":
            self.mutations.append((route, copy.deepcopy(body)))
            if self.capacity:
                return 202, dict(body, state="queued", window_id=None)
            if self.busy:
                return 409, dict(error="window_busy")
            intake = next(item for item in self.inputs if item["message_id"] == body["input_message_id"])
            intake["window"] = True
            self.start("fast")
            self.start("deep")
            return 201, dict(body, status=dict(conversation_id=self.conversation, state="active", generation=1,
                                             window_id="window", predecessor_window_id=None))
        path, _, run_id = route.partition("?run_id=")
        if path in ("/execution", "/fast/execution"):
            role = "fast" if path.startswith("/fast") else "deep"
            value = next((value for value in self.runs.values()
                          if value["run_id"] == run_id and value["role"] == role), None)
            return (200, dict(value, revision=self.revision)) if value else (404, dict(code="not_found"))
        if route.startswith("/payloads/"):
            payload = route.removeprefix("/payloads/")
            run = payload.removesuffix("-payload")
            role = next((value["role"] for value in self.runs.values() if value["run_id"] == run), "deep")
            text = ("Quick reply: looking into it now. " if role == "fast" else
                    "Here is the complete, checked result of the whole request: ") + run
            return 200, dict(run_id=run, payload_id=payload, text=self.texts.get(run, text))
        if route == "/accept":
            self.mutations.append((route, copy.deepcopy(body)))
            if body["request_key"] in self.receipts:
                receipt = self.receipts[body["request_key"]]
                assert receipt["requested_revision"] == body["expected_revision"]
                return 200, copy.deepcopy(receipt)
            if self.before_accept:
                self.before_accept(body)
            if body["expected_revision"] != self.revision:
                raise ClientError("unexpected_status", 409)
            value = next(value for value in self.runs.values() if value["run_id"] == body["run_id"])
            assert value["phase"] == "awaiting_acceptance"
            assert value["acceptance_candidate"]["completion_event_id"] == body["completion_event_id"]
            value["phase"] = "completed"
            self.revision += 1
            receipt = dict(body, requested_revision=body["expected_revision"], outcome="succeeded",
                           acceptance_event_id=value["run_id"] + "-accepted", revision=self.revision)
            self.receipts[body["request_key"]] = receipt
            self.start(value["role"])
            return 200, copy.deepcopy(receipt)
        if route.startswith("/accepted-results?"):
            return 200, dict(results=[dict(run_id=receipt["run_id"],
                completion_event_id=receipt["completion_event_id"], acceptance_event_id=receipt["acceptance_event_id"],
                payload_id=receipt["run_id"] + "-payload", payload_removed=False)
                for receipt in self.receipts.values()], next_after_sequence=None)
        return super().request(method, route, body, allowed)


class Stop:
    def wait(self, _):
        pass


class IntakeBase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.ledger = Ledger(Path(temporary.name) / "ledger.sqlite3", {"test_scope": "intake"})
        self.peer = IntakePeer()
        self.worker = self.new_worker()

    def new_worker(self):
        worker = Worker(self.peer, self.ledger, burst_quiet_s=3)
        worker.fast_reply_policy = "owner_only"
        worker.web_mirror = False
        worker._timers_checked = worker._posts_checked = worker._digest_checked = time.monotonic()
        return worker

    def enqueue(self, public="first", role="owner"):
        return self.ledger.enqueue(dict(publicMessageId=public, publicThreadId="thread", chatId="chat",
            accountId="account", text="Request " + public),
            author=dict(role=role, id="synthetic-" + role, label=role))[0]

    def row(self, public):
        with self.ledger.connect() as db:
            return json.loads(db.execute("SELECT data FROM inputs WHERE public_id=?", (public,)).fetchone()[0])

    def fast(self):
        return [message for message in self.ledger.messages(500) if message.get("firstResponse")]

    def mutations(self, route):
        return [body for path, body in self.peer.mutations if path == route]
