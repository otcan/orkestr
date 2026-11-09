"""Controlled pressure at the actual pre-proof HTTP exchange boundary."""
import contextlib
import threading
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import foreground, rust_client
from v2.compat.v1_runtime.outbound_gate import OutboundGate
from v2.compat.v1_runtime.rust_client import ClientError, RustSession
from v2.compat.v1_runtime.service_peer import PeerError
from v2.compat.v1_runtime.worker import transient


class Transport:
    def __init__(self, block=False, error=None):
        self.changed = threading.Condition()
        self.release = threading.Event()
        if not block:
            self.release.set()
        self.error = error
        self.constructed = []
        self.active = self.maximum = 0

    def connection(self, *args, **kwargs):
        if self.error == "constructor":
            raise PeerError("peer_binding_unavailable")
        transport = self

        class Connection:
            offered_bytes = False
            closed = False

            def __init__(self):
                self.sock = self
                with transport.changed:
                    transport.constructed.append(kwargs)
                    transport.active += 1
                    transport.maximum = max(transport.maximum, transport.active)
                    transport.changed.notify_all()

            def connect(self):
                if transport.error == "connect":
                    raise OSError("synthetic connect")
                if not transport.release.wait(2):
                    raise OSError("test did not release exchange")

            def shutdown(self, *_):
                pass

            def request(self, *_args, **_kwargs):
                self.offered_bytes = True
                if transport.error == "after_send":
                    raise PeerError("peer_actor_changed")

            def getresponse(self):
                if transport.error == "response":
                    raise OSError("synthetic response")
                return Response()

            def close(self):
                if not self.closed:
                    self.closed = True
                    with transport.changed:
                        transport.active -= 1
                if transport.error == "connection_close":
                    raise OSError("synthetic close")

        class Response:
            status = 200
            length = 0
            raw = b'{"ok":true}'

            def getheader(self, name, default=None):
                return "application/json" if name == "Content-Type" else default

            def getheaders(self):
                return []

            def read1(self, _size):
                if transport.error == "read":
                    raise OSError("synthetic read")
                raw, self.raw = self.raw, b""
                return raw

            def close(self):
                if transport.error == "response_close":
                    raise OSError("synthetic response close")

        return Connection()

    def wait_for(self, count):
        with self.changed:
            return self.changed.wait_for(lambda: len(self.constructed) >= count, 2)


class OutboundGateTests(unittest.TestCase):
    def session(self, gate, timeout=5):
        return RustSession(origin="https://synthetic.example", loopback_url="http://127.0.0.1:47110",
            credentials_path="/synthetic/never-read.json", expected_owner="00000000-0000-4000-8000-000000000001",
            expected_source="a" * 40, peer_descriptor_path="/synthetic/peer.json",
            timeout_s=timeout, outbound_gate=gate)

    def test_same_transport_without_adapter_gate_reproduces_nine_concurrent_proofs(self):
        transport, failures = Transport(block=True), []
        def exchange():
            try:
                self.session(None)._wire("GET", "/api/v2/health")
            except BaseException as error:
                failures.append(error)
        threads = [threading.Thread(target=exchange) for _ in range(9)]
        with patch.object(rust_client, "PeerConnection", transport.connection):
            try:
                for thread in threads:
                    thread.start()
                self.assertTrue(transport.wait_for(9))
            finally:
                transport.release.set()
                for thread in threads:
                    thread.join(3)
        self.assertEqual(transport.maximum, 9)
        self.assertFalse(failures)

    def test_one_process_gate_bounds_eight_and_reserves_foreground_preflight_get(self):
        gate, transport = OutboundGate(), Transport(block=True)
        errors, threads = [], []

        def exchange(priority=False):
            try:
                with gate.foreground() if priority else contextlib.nullcontext():
                    self.session(gate)._wire("GET", "/api/v2/health")
            except BaseException as error:
                errors.append(error)

        with patch.object(rust_client, "PeerConnection", transport.connection):
            try:
                for _ in range(7):
                    thread = threading.Thread(target=exchange)
                    threads.append(thread)
                    thread.start()
                self.assertTrue(transport.wait_for(7))
                # Background cannot steal the reserved slot, nor construct a Binding.
                with self.assertRaises(ClientError) as caught:
                    self.session(gate)._wire("GET", "/api/v2/health")
                self.assertEqual((caught.exception.code, caught.exception.outcome),
                                 ("outbound_capacity_refused", "refused"))
                self.assertEqual(len(transport.constructed), 7)
                thread = threading.Thread(target=exchange, args=(True,))
                threads.append(thread)
                thread.start()
                self.assertTrue(transport.wait_for(8))
                with gate.foreground(), self.assertRaises(ClientError):
                    self.session(gate)._wire("GET", "/api/v2/health")
                self.assertEqual(len(transport.constructed), 8)
            finally:
                transport.release.set()
                for thread in threads:
                    thread.join(3)
        self.assertFalse(errors)
        self.assertFalse(any(t.is_alive() for t in threads))
        self.assertEqual((transport.maximum, transport.active), (8, 0))

    def test_queue_time_is_inside_original_deadline_before_connect_or_send(self):
        gate, transport = OutboundGate(), Transport()
        held = [gate.acquire(time.monotonic() + 1) for _ in range(7)]
        timer = threading.Timer(0.08, held.pop().release)
        timer.start()
        started = time.monotonic()
        try:
            with patch.object(rust_client, "PeerConnection", transport.connection):
                self.session(gate, 0.5)._wire("GET", "/api/v2/health")
        finally:
            timer.join()
            for permit in held:
                permit.release()
        observed = transport.constructed[0]
        self.assertGreater(time.monotonic() - started, 0.06)
        self.assertLess(observed["timeout"], 0.45)
        self.assertLessEqual(observed["deadline"], started + 0.51)

    def test_expired_queue_never_constructs_peer_and_is_explicit_safe_refusal(self):
        gate, transport = OutboundGate(), Transport()
        held = [gate.acquire(time.monotonic() + 1) for _ in range(7)]
        started = time.monotonic()
        try:
            with patch.object(rust_client, "PeerConnection", transport.connection), self.assertRaises(ClientError) as caught:
                self.session(gate, 0.04)._wire("POST", rust_client.SERVICE_SESSION, {"synthetic": True})
            self.assertEqual(transport.constructed, [])
            self.assertLess(time.monotonic() - started, 0.2)
            self.assertEqual(caught.exception.outcome, "refused")
            self.assertTrue(transient(caught.exception))
            self.assertFalse(transient(ClientError("outbound_capacity_refused", outcome="unknown")))
        finally:
            for permit in held:
                permit.release()

    def test_every_transport_error_releases_both_slots_and_preserves_unknown_after_send(self):
        for stage in ["constructor", "connect", "after_send", "response", "read", "response_close", "connection_close"]:
            with self.subTest(stage=stage):
                gate, transport = OutboundGate(), Transport(error=stage)
                with patch.object(rust_client, "PeerConnection", transport.connection), self.assertRaises(Exception) as caught:
                    self.session(gate)._wire("GET", "/api/v2/health")
                if stage == "after_send":
                    self.assertEqual(caught.exception.code, "peer_changed_outcome_unknown")
                    self.assertEqual(caught.exception.outcome, "unknown")
                    self.assertFalse(transient(caught.exception))
                permits = [gate.acquire(time.monotonic() + 1) for _ in range(7)]
                self.assertTrue(all(permits))
                for permit in permits:
                    permit.release()
                self.assertEqual(transport.active, 0)

    def test_foreground_context_covers_step_and_restores_on_error(self):
        gate = OutboundGate()
        class Worker:
            client = type("Client", (), {"session": type("Session", (), {"outbound_gate": gate})()})()
            def step(self, _data):
                self_observed.append(getattr(gate.local, "foreground", False))
                raise KeyboardInterrupt()
        self_observed = []
        with self.assertRaises(KeyboardInterrupt):
            foreground.drive(Worker(), {}, None)
        self.assertEqual(self_observed, [True])
        self.assertFalse(getattr(gate.local, "foreground", False))

    def test_interrupted_second_slot_acquisition_releases_background_slot(self):
        gate = OutboundGate()
        with patch.object(gate.active, "acquire", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                gate.acquire(time.monotonic() + 1)
        permits = [gate.acquire(time.monotonic() + 1) for _ in range(7)]
        self.assertTrue(all(permits))
        for permit in permits:
            permit.release()


if __name__ == "__main__":
    unittest.main()
