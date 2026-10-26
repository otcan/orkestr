"""Persistent Fast faults cannot decide Deep or resurrect late/historical output."""
import contextlib
import copy
import io
import json
from unittest.mock import patch

from v2.compat.v1_runtime import fast_watch
from v2.compat.v1_runtime import worker as worker_module
from v2.compat.v1_runtime.intake_fast import MAX_FAST_OBSERVATIONS, drive
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import intake_fixture as fixture


class FastWatchTests(fixture.IntakeBase):
    def watches(self):
        with self.ledger.connect() as db:
            return [json.loads(raw) for (raw,) in db.execute("SELECT data FROM fast_watch ORDER BY rowid")]

    def finals(self):
        with self.ledger.connect() as db:
            messages = [json.loads(raw) for (raw,) in db.execute("SELECT message FROM exports ORDER BY seq")]
        return [value for value in messages if value.get("source") == "rust-v2-pilot"]

    def once(self, at, restart=False):
        if restart:
            self.worker = self.new_worker()
        with patch("time.time", return_value=at), contextlib.redirect_stderr(io.StringIO()):
            self.worker.run_once(fixture.Stop())

    def fault(self, kind, deep_text=None):
        request = self.peer.request
        def failed(method, route, **kwargs):
            fast = self.peer.runs.get((0, "fast")) or {}
            if kind == "status" and route.startswith("/fast/execution"):
                raise ClientError("unexpected_status", 403)
            if route == "/accept" and (kwargs.get("body") or {}).get("run_id") == fast.get("run_id"):
                if kind == "accept_unknown":
                    raise ClientError("transport_outcome_unknown")
                if kind == "accept":
                    raise ClientError("unexpected_status", 403)
            status, value = request(method, route, **kwargs)
            if kind == "payload" and route == "/payloads/" + (fast.get("progress") or {}).get("payload_id", ""):
                value = dict(value, run_id=fixture.identity(9999))
            deep = self.peer.runs.get((0, "deep")) or {}
            if deep_text is not None and route == "/payloads/" + (deep.get("progress") or {}).get("payload_id", ""):
                value = dict(value, text=deep_text)
            return status, value
        self.peer.request = failed
        return request

    def test_full_run_once_persistent_fast_faults_preserve_deep_and_only_its_proven_final(self):
        for kind in ("status", "payload", "accept", "accept_unknown"):
            with self.subTest(kind=kind):
                self.setUp()
                original = self.enqueue()
                request = self.fault(kind)
                self.once(100)
                first_watch = self.watches()[0]
                frozen = copy.deepcopy(first_watch.get("fast_accept_request"))
                self.once(101, restart=True)
                self.assertEqual(self.row("first")["phase"], "running")
                self.assertNotIn("refused", self.row("first"))
                self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
                self.assertEqual(self.finals(), [])
                self.assertEqual(self.watches()[0].get("fast_accept_request"), frozen)
                self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
                self.once(102)
                if kind.startswith("accept"):
                    self.assertEqual(self.finals(), [], "prepared Fast keeps its existing transport fence")
                    self.once(116, restart=True)
                    self.assertEqual(self.finals(), [])
                    self.once(117)
                self.assertEqual(self.row("first")["phase"], "completed")
                self.assertNotIn("refused", self.row("first"))
                self.assertEqual(len(self.finals()), 1)
                final = self.finals()[0]
                self.assertEqual((final["parentMessageId"], final["runId"]),
                                 (original["remote_id"], self.peer.runs[0, "deep"]["run_id"]))
                self.assertNotIn("fast", self.row("first").get("accepted", {}))
                self.assertEqual(self.watches()[0].get("fast_accept_request"), frozen)
                self.peer.request = request
                self.once(118, restart=True)
                self.once(119, restart=True)
                self.assertTrue(self.watches()[0]["closed"])
                self.assertEqual(self.finals(), [final])
                self.assertEqual(self.fast(), [], "no newly late/superseded Fast is exported after a substantive final")
                self.assertEqual(len(self.mutations("/messages")), 1)

    def test_no_reply_completion_and_ack_keep_fast_exportable(self):
        original = self.enqueue()
        request = self.fault("status", deep_text="NO_REPLY")
        self.once(100)
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.once(101, restart=True)
        final = self.finals()[0]
        self.assertTrue(final["noReply"])
        self.assertNotIn("substantive_deep_final_prepared", self.row("first"))
        self.ledger.acknowledge(final["id"], dict(outcome="no_reply", parentPublicMessageId="first", connectorMessageIds=[]))
        self.assertNotIn("text", self.row("first"))
        self.peer.request = request
        self.once(102, restart=True)
        fast = self.fast()
        self.assertEqual(len(fast), 1)
        self.assertEqual(fast[0]["sourceInputId"], original["remote_id"])
        self.assertTrue(self.watches()[0]["closed"])
        self.once(103, restart=True)
        self.assertEqual(self.fast(), fast)

    def test_no_reply_ack_keeps_busy_cadence_for_running_or_unknown_fast(self):
        for phase in ("running", "unknown"):
            with self.subTest(phase=phase):
                self.setUp()
                self.enqueue()
                start = self.peer.start
                def running(role):
                    start(role)
                    value = self.peer.runs.get((0, "fast"))
                    if role == "fast" and value and value["phase"] == "awaiting_acceptance":
                        value["phase"] = "running"
                self.peer.start = running
                request = self.fault("status" if phase == "unknown" else "running", deep_text="NO_REPLY")
                self.once(100)
                self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
                self.once(101)
                final = self.finals()[0]
                self.assertTrue(final["noReply"])
                self.ledger.acknowledge(final["id"], dict(outcome="no_reply", parentPublicMessageId="first", connectorMessageIds=[]))
                self.assertIsNone(self.ledger.next_input())
                self.worker = self.new_worker()
                with patch("time.time", return_value=102), contextlib.redirect_stderr(io.StringIO()):
                    busy = self.worker.run_once(fixture.Stop())
                self.assertTrue(busy, "retained Fast must not fall back to the five-second idle pass")
                self.assertEqual(self.worker.busy_pause(), worker_module.FAST_PASS_S,
                                 "pending owner Fast work is passed at the fast pace")
                self.worker._fast_since -= worker_module.FAST_PACE_S
                self.assertEqual(self.worker.busy_pause(), worker_module.PASS_S,
                                 "a long-retained watch falls back to the ordinary busy pass")
                self.assertFalse(self.watches()[0].get("closed", False))
                self.peer.runs[0, "fast"]["phase"] = "awaiting_acceptance"
                self.peer.request = request
                with patch("time.time", return_value=103):
                    self.assertFalse(self.worker.run_once(fixture.Stop()), "idle resumes once retained work is resolved")
                self.assertEqual(len(self.fast()), 1)

    def test_failed_lost_and_blocked_diagnostics_do_not_claim_provider_terminal(self):
        for phase in ("failed", "lost", "blocked"):
            with self.subTest(phase=phase):
                self.setUp()
                self.enqueue()
                start = self.peer.start
                def unavailable(role):
                    start(role)
                    if role == "fast":
                        self.peer.runs[0, "fast"]["phase"] = phase
                self.peer.start = unavailable
                self.once(100)
                self.assertEqual(self.watches()[0]["diagnostic"]["reason"], "observed_fast_unavailable")
                self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
                self.assertNotIn("fast", self.row("first").get("accepted", {}))
                self.assertEqual(self.mutations("/accept"), [])

    def test_original_watch_source_and_unknown_request_survive_deep_continuation(self):
        self.enqueue()
        self.fault("accept_unknown")
        self.once(100)
        original_watch = copy.deepcopy(self.watches()[0])
        # The existing continuation path replaces Deep's intake/keys on this
        # owner row. Use the same supported synthetic intake/window surfaces.
        intake = self.peer.request("POST", "/messages", body=dict(client_message_id="continuation-source", text="Continue"))[1]
        request = self.peer.window_request(intake, "continuation-source", "continuation-window", None)
        window = self.peer.request("POST", "/window", body=request)[1]
        current = self.row("first")
        current.update(intake=intake, window=window, cursor=intake["sequence"] - 1, matched_runs=[],
                       continued=dict(previous_message_id=original_watch["intake"]["message_id"]), accepted={})
        current["keys"] = dict(current["keys"], fast="continuation-fast-key")
        current.pop("fast_accept_request", None)
        current.pop("fast_payload", None)
        self.ledger.save(current)
        self.once(101, restart=True)
        after = self.watches()[0]
        for key in ("intake", "keys", "fast_accept_request", "watch_id"):
            self.assertEqual(after[key], original_watch[key])
        self.assertGreaterEqual(after["fast_cursor"], original_watch["fast_cursor"])
        self.assertEqual(self.row("first")["intake"], intake)
        self.assertEqual(self.row("first")["keys"]["fast"], "continuation-fast-key")
        self.assertNotIn("fast_accept_request", self.row("first"))
        self.assertNotIn(original_watch["fast_accept_request"]["run_id"], self.row("first")["matched_runs"])

    def test_faulted_old_watches_do_not_starve_a_new_source(self):
        for index in range(MAX_FAST_OBSERVATIONS + 2):
            self.enqueue(str(index))
        request = self.peer.request
        def old_status_failed(method, route, **kwargs):
            if route.startswith("/fast/execution") and "?run_id=" in route:
                run = route.split("?run_id=")[1]
                if any(value["run_id"] == run for (index, role), value in self.peer.runs.items()
                       if index < MAX_FAST_OBSERVATIONS + 2 and role == "fast"):
                    raise ClientError("unexpected_status", 403)
            return request(method, route, **kwargs)
        self.peer.request = old_status_failed
        with contextlib.redirect_stderr(io.StringIO()):
            drive(self.worker)
            drive(self.worker)
        # Core may have accepted these independently; adapter failures must not
        # allow their unresolved watches to monopolize the bounded poll pass.
        for index in range(MAX_FAST_OBSERVATIONS + 2):
            value = self.peer.runs[index, "fast"]
            request("POST", "/accept", body=dict(run_id=value["run_id"],
                completion_event_id=value["acceptance_candidate"]["completion_event_id"],
                expected_revision=self.peer.revision, request_key="core-accept-" + str(index)))
        fresh = self.enqueue("fresh")
        with contextlib.redirect_stderr(io.StringIO()):
            drive(self.worker)
        self.assertIn(fresh["remote_id"], [value["sourceInputId"] for value in self.fast()])

    def test_historical_completed_sources_are_not_scanned_or_resurrected(self):
        data = self.enqueue("historical")
        data.update(phase="completed", intake=dict(message_id="old", event_id="old", sequence=1), window={})
        self.ledger.save(data)
        self.once(100, restart=True)
        self.assertEqual(self.watches(), [])
        self.assertEqual(self.peer.mutations, [])

    def test_watch_source_and_request_key_are_immutable_at_the_store_boundary(self):
        self.enqueue()
        self.fault("status")
        self.once(100)
        before = self.watches()[0]
        original = self.row("first")
        for field in ("intake", "keys"):
            with self.subTest(field=field):
                changed = copy.deepcopy(before)
                changed[field] = dict(changed[field], **({"event_id": fixture.identity(9999)}
                    if field == "intake" else {"fast": "another-source-key"}))
                with self.assertRaisesRegex(ValueError, "fast_watch_scope_changed"):
                    fast_watch.Ledger(self.ledger).save(changed)
        self.assertEqual(self.watches()[0], before)
        self.assertEqual(self.row("first"), original)

    def test_unstarted_watch_requires_accepted_source_closed_window_and_complete_journal(self):
        self.enqueue()
        start = self.peer.start
        self.peer.start = lambda role: start(role) if role == "deep" else None
        self.once(100)
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.once(101)
        self.assertNotIn("closed", self.watches()[0])
        request = self.peer.request
        state = dict(complete=False, closed=False)
        def proof(method, route, **kwargs):
            if route == "":
                tail = max(event["sequence"] for event in self.peer.events)
                return 200, dict(conversation_id=self.peer.conversation,
                                 last_sequence=tail if state["complete"] else tail + 1)
            if route == "/window" and method == "GET":
                window = copy.deepcopy(self.watches()[0]["window"]["status"])
                window["state"] = "closed" if state["closed"] else "active"
                return 200, window
            return request(method, route, **kwargs)
        self.peer.request = proof
        self.once(102, restart=True)
        self.assertNotIn("closed", self.watches()[0])
        state["closed"] = True
        self.once(103)
        self.assertNotIn("closed", self.watches()[0], "closed window alone cannot hide an unread Fast event")
        state["complete"] = True
        self.once(104)
        watch = self.watches()[0]
        self.assertTrue(watch["closed"])
        self.assertEqual(watch["diagnostic"]["reason"], "unstarted_source_window_ineligible")
        self.assertNotIn("phase", watch["diagnostic"], "no provider terminal was inferred")
        self.assertNotIn("fast", self.row("first")["accepted"])
