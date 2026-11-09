"""Real blocked discovery and exact canonical-receipt reuse regressions."""
import copy
import threading
import time
from unittest.mock import patch

from v2.compat.v1_runtime.worker import Worker, Refused
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests.test_single_agent import SingleIntakePeer


class ForegroundFinalTests(fixture.IntakeBase):
    def setUp(self):
        super().setUp()
        self.peer = SingleIntakePeer()
        self.worker = self.new_worker()

    def new_worker(self):
        worker = Worker(self.peer, self.ledger)
        worker.web_mirror = False
        worker._timers_checked = worker._posts_checked = worker._digest_checked = time.monotonic()
        return worker

    def canonical_final(self):
        self.enqueue()
        self.worker.run_once(fixture.Stop())
        data = self.ledger.next_input()
        run = self.peer.runs[0, "deep"]
        run["phase"] = "awaiting_acceptance"
        run["models"] = {"provider": "codex", "actual_model": "synthetic-model"}
        self.peer.request("POST", "/accept", body={
            "run_id": run["run_id"],
            "completion_event_id": run["acceptance_candidate"]["completion_event_id"],
            "expected_revision": self.peer.revision,
            "request_key": "synthetic-core-auto-accept",
        })
        self.peer.mutations.clear()
        return data

    def test_durable_final_is_visible_while_background_discovery_is_blocked(self):
        self.canonical_final()
        entered, release = threading.Event(), threading.Event()
        errors = []

        def discovery():
            entered.set()
            if not release.wait(2):
                raise RuntimeError("bounded synthetic discovery wait expired")

        self.worker._timers_checked = None
        self.worker.discover_timers = discovery

        def run():
            try:
                self.worker.run_once(fixture.Stop())
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=run)
        thread.start()
        try:
            self.assertTrue(entered.wait(1), "the background pass must still run")
            finals = [m for m in self.ledger.messages() if m["role"] == "assistant"]
            self.assertEqual(len(finals), 1, "canonical final must commit before background waits")
            self.assertEqual(finals[0]["runId"], self.peer.runs[0, "deep"]["run_id"])
        finally:
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertFalse(self.mutations("/accept"), "Core acceptance is adopted, never repeated")

    def test_one_pass_reuses_only_exact_status_and_canonical_result(self):
        data = self.canonical_final()
        original = self.peer.request
        reads = []

        def request(method, route, **kwargs):
            if method == "GET":
                reads.append(route)
            return original(method, route, **kwargs)

        self.peer.request = request
        self.worker.step(data)
        run = self.peer.runs[0, "deep"]["run_id"]
        self.assertEqual(reads.count("/execution?run_id=" + run), 1)
        self.assertEqual(sum(route.startswith("/accepted-results?") for route in reads), 1)
        finals = [m for m in self.ledger.messages() if m["role"] == "assistant"]
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0]["runId"], run)
        self.assertEqual(finals[0]["model"], "synthetic-model")
        self.assertFalse(self.mutations("/accept"))

    def test_stop_during_foreground_does_not_start_background_discovery(self):
        self.canonical_final()
        stop = threading.Event()
        original = self.worker.step

        def finishing(data):
            original(data)
            stop.set()

        self.worker.step = finishing
        self.worker._timers_checked = None
        with patch.object(self.worker, "discover_timers") as discovery:
            self.worker.run_once(stop)
        discovery.assert_not_called()
        self.assertEqual(len([m for m in self.ledger.messages() if m["role"] == "assistant"]), 1)

    def test_a_later_pass_revalidates_canonical_evidence_after_unexported_result(self):
        data = self.canonical_final()
        with patch.object(self.ledger, "complete", return_value=False):
            self.worker.step(data)
        self.assertEqual(self.ledger.messages()[-1]["role"], "user")
        original = self.peer.request

        def removed(method, route, **kwargs):
            status, value = original(method, route, **kwargs)
            if route.startswith("/accepted-results?"):
                value = copy.deepcopy(value)
                for row in value["results"]:
                    row["payload_removed"] = True
            return status, value

        self.peer.request = removed
        with self.assertRaisesRegex(Refused, "accepted_history_mismatch"):
            self.worker.step(self.ledger.next_input())
        self.assertFalse([m for m in self.ledger.messages() if m["role"] == "assistant"])
        self.assertFalse(self.mutations("/accept"))
