"""A refused transport observation must preserve the already admitted turn."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests.test_refusals import Stop, body
from v2.compat.v1_runtime.tests.test_worker import Peer
from v2.compat.v1_runtime.worker import Worker, transient


class PeerObservationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.ledger = Ledger(Path(directory.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.peer = Peer()
        self.worker = Worker(self.peer, self.ledger, legacy_companions=True)

    def test_before_send_refusal_after_admission_observes_same_turn_without_replay(self):
        original = self.peer.request
        failures = []

        def request(method, route, **kwargs):
            if method == "GET" and route.startswith("/execution") and not failures:
                failures.append(route)
                raise ClientError("peer_identity_refused", outcome="refused")
            return original(method, route, **kwargs)

        self.peer.request = request
        data, _ = self.ledger.enqueue(body("first"))
        with contextlib.redirect_stderr(io.StringIO()):
            self.worker.run_once(Stop())
        pending = self.ledger.next_input()
        self.assertIsNotNone(pending)
        self.assertEqual(pending["intake"]["message_id"], "message")
        self.assertEqual(pending["keys"], data["keys"])
        self.assertNotIn("refused", pending)
        self.assertFalse(any(m.get("refusal") for m in self.ledger.messages()))
        self.worker.run_once(Stop())
        self.assertIsNone(self.ledger.next_input())
        self.assertEqual(sum(r == "/messages" for r, _ in self.peer.mutations), 1)
        self.assertEqual(sum(r == "/window" for r, _ in self.peer.mutations), 1)
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")

    def test_only_explicit_zero_byte_transport_refusals_are_retryable(self):
        for code in ("peer_identity_refused", "peer_connection_refused"):
            with self.subTest(code=code):
                self.assertTrue(transient(ClientError(code, outcome="refused")))
                self.assertFalse(transient(ClientError(code)))
                self.assertFalse(transient(ClientError(code, outcome="unknown")))
        self.assertFalse(transient(ClientError("peer_changed_outcome_unknown", outcome="unknown")))

    def test_persistent_peer_refusal_never_resubmits_the_accepted_message(self):
        original = self.peer.request

        def request(method, route, **kwargs):
            if method == "GET" and route.startswith("/execution"):
                raise ClientError("peer_identity_refused", outcome="refused")
            return original(method, route, **kwargs)

        self.peer.request = request
        self.ledger.enqueue(body("first"))
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            for _ in range(3):
                self.worker.run_once(Stop())
        self.assertIsNotNone(self.ledger.next_input())
        self.assertEqual(sum(r == "/messages" for r, _ in self.peer.mutations), 1)
        self.assertEqual(sum(r == "/window" for r, _ in self.peer.mutations), 1)
        self.assertFalse(any(m.get("refusal") for m in self.ledger.messages()))
        self.assertEqual(log.getvalue().count("peer_transport_held"), 1)


if __name__ == "__main__":
    unittest.main()
