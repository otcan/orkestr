import os
import socket
import threading
import time
import unittest
from dataclasses import replace

from bounded_proxy_fixture import Fixture, REQUEST
from isolation.bounded_budget import Budget, Context, Limits, Refused
from isolation.bounded_io import ESTABLISHED, MAGIC, PRELUDE, read_prelude


class ControlFrameTests(unittest.TestCase):
    def test_coalesced_frame_preserves_connect_and_original_deadline(self):
        client, peer = socket.socketpair()
        self.addCleanup(client.close);self.addCleanup(peer.close)
        accepted = time.monotonic_ns() - 100_000_000
        context = Context(client, Budget())
        peer.sendall(PRELUDE.pack(MAGIC, accepted) + REQUEST)
        self.assertTrue(read_prelude(context))
        self.assertEqual(client.recv(4096), REQUEST)
        self.assertEqual(context.deadline, accepted / 1e9 + 2)

    def test_wrong_version_zero_future_and_stale_frames_refused(self):
        for kind in ("version", "zero", "future", "stale"):
            with self.subTest(kind=kind):
                client, peer = socket.socketpair()
                try:
                    context = Context(client, Budget())
                    value = {"zero": 0, "future": context.accepted_ns + 1,
                        "stale": context.accepted_ns - 3_000_000_000}.get(kind, context.accepted_ns)
                    peer.sendall(PRELUDE.pack(b"badframe" if kind == "version" else MAGIC, value))
                    with self.assertRaises(Refused):read_prelude(context)
                finally:
                    client.close();peer.close()

    def test_partial_and_truncated_frame_never_renews_deadline(self):
        client, peer = socket.socketpair()
        try:
            context = Context(client, Budget(replace(Limits(), setup_seconds=.1)))
            original = context.deadline
            peer.sendall(MAGIC)
            self.assertFalse(read_prelude(context, False))
            self.assertEqual(context.deadline, original)
            peer.close()
            with self.assertRaises(Refused):read_prelude(context)
        finally:
            client.close();peer.close()

    def test_stalled_partial_frame_hits_absolute_deadline(self):
        client, peer = socket.socketpair()
        try:
            context = Context(client, Budget(replace(Limits(), setup_seconds=.1)))
            peer.sendall(MAGIC)
            started=time.monotonic()
            with self.assertRaises(Refused):read_prelude(context)
            self.assertLess(time.monotonic()-started,.8)
        finally:
            client.close();peer.close()


class PathTests(unittest.TestCase):
    def test_actual_inner_outer_connect_and_combined_direction_accounting(self):
        with Fixture() as fixture:
            client = fixture.client()
            self.assertEqual(fixture.response(client), ESTABLISHED)
            client.sendall(b"abc")
            self.assertEqual(client.recv(3), b"abc")
            fixture.until(lambda: fixture.budget.bytes == 6)
            self.assertEqual(fixture.budget.attempts, 1)
            self.assertEqual(fixture.inner.budget.bytes, 6)

    def test_eight_active_four_pending_no_connect_forwarded_while_pending(self):
        with Fixture() as fixture:
            active = [fixture.client() for _ in range(8)]
            for client in active:self.assertEqual(fixture.response(client), ESTABLISHED)
            pending = [fixture.client() for _ in range(4)]
            fixture.until(lambda: fixture.budget.attempts == 12 and len(fixture.pool.pending)==4)
            self.assertEqual(fixture.resolves, 8)
            self.assertEqual(len(fixture.inner.pool.pending), 4)
            self.assertEqual(len(fixture.pool.pending), 4)
            inner_contexts=[c for c,_ in fixture.inner.pool.active]+list(fixture.inner.pool.pending)
            outer_contexts=[c for c,_ in fixture.pool.active]+list(fixture.pool.pending)
            self.assertEqual(sum(len(c.sockets) for c in inner_contexts),24)
            self.assertEqual(sum(len(c.sockets) for c in outer_contexts),20)
            active[0].close()
            fixture.until(lambda: fixture.resolves == 9)
            self.assertEqual(fixture.response(pending[0]), ESTABLISHED)
            self.assertEqual((fixture.inner.pool.peak_active, fixture.pool.peak_active), (8, 8))

    def test_cancel_pending_with_unread_connect_closes_retained_root_channel(self):
        with Fixture(replace(Limits(),active=1,pending=1)) as fixture:
            active=fixture.client();self.assertEqual(fixture.response(active),ESTABLISHED)
            pending=fixture.client(REQUEST+b'unread synthetic bytes')
            fixture.until(lambda:len(fixture.pool.pending)==1)
            started=time.monotonic();pending.shutdown(socket.SHUT_WR)
            fixture.until(lambda:not fixture.inner.pool.pending and not fixture.pool.pending,.7)
            self.assertLess(time.monotonic()-started,.7)
            self.assertEqual(fixture.resolves,1)
            self.assertTrue(fixture.contexts[1].cancelled.is_set())

    def test_absolute_pending_deadline_not_a_second_setup_window(self):
        limits = replace(Limits(), active=1, pending=1, setup_seconds=.3)
        with Fixture(limits) as fixture:
            active = fixture.client()
            self.assertEqual(fixture.response(active), ESTABLISHED)
            pending = fixture.client()
            started = time.monotonic()
            fixture.until(lambda: not fixture.inner.pool.pending, seconds=1)
            self.assertEqual(pending.recv(1), b"")
            self.assertLess(time.monotonic() - started, .8)
            self.assertEqual(fixture.resolves, 1)
            active.sendall(b"still active")
            self.assertEqual(active.recv(12), b"still active")

    def test_root_aggregate_survives_replacement_natives(self):
        with Fixture(replace(Limits(), aggregate_bytes=12)) as fixture:
            for _ in range(2):
                client = fixture.client()
                self.assertEqual(fixture.response(client), ESTABLISHED)
                client.sendall(b"abc");self.assertEqual(client.recv(3), b"abc")
                fixture.replace_inner()
            self.assertEqual(fixture.budget.bytes, 12)
            self.assertEqual(fixture.inner.budget.bytes, 0)
            client = fixture.client()
            self.assertEqual(fixture.response(client), ESTABLISHED)
            client.sendall(b"x")
            fixture.until(lambda: fixture.budget.stopped.is_set())
            self.assertEqual(client.recv(1), b"")
            self.assertEqual(fixture.budget.bytes, 12)
            self.assertEqual(fixture.budget.attempts, 3)

    def test_root_request_budget_counts_inner_capacity_refusal_and_survives_replacement(self):
        with Fixture(replace(Limits(), active=1, pending=1, attempts=3)) as fixture:
            active = fixture.client();self.assertEqual(fixture.response(active), ESTABLISHED)
            fixture.client()
            refused = fixture.client(request=None)
            fixture.until(lambda: fixture.budget.attempts == 3)
            self.assertEqual(refused.recv(1), b"")
            fixture.replace_inner()
            refused = fixture.client()
            self.assertEqual(fixture.response(refused), b"")
            self.assertEqual(fixture.budget.attempts, 3)

    def test_retired_endpoint_epoch_does_not_refund_budget_or_lifetime(self):
        from isolation.bounded_pool import Pool
        budget=Budget();initial=budget.created
        first=Pool(lambda c:None,budget,outer=True)
        budget.attempt();budget.bytes=123
        first.retire()
        successor=Pool(lambda c:None,budget,outer=True)
        try:
            self.assertFalse(budget.stopped.is_set())
            self.assertEqual((successor.budget.created,successor.budget.bytes,successor.budget.attempts),
                (initial,123,1))
        finally:successor.close()

    def test_controller_lifetime_cannot_be_extended_by_native_replacement(self):
        with Fixture(replace(Limits(),lifetime_seconds=.4)) as fixture:
            first=fixture.client();self.assertEqual(fixture.response(first),ESTABLISHED)
            created=fixture.budget.created
            fixture.replace_inner()
            second=fixture.client();self.assertEqual(fixture.response(second),ESTABLISHED)
            fixture.until(lambda:fixture.budget.stopped.is_set(),seconds=1.2)
            self.assertEqual(fixture.budget.created,created)
            self.assertEqual(second.recv(1),b'')

    def test_bad_destination_never_reaches_resolver(self):
        with Fixture() as fixture:
            client = fixture.client(REQUEST.replace(b"fixture.example", b"other.example"))
            self.assertEqual(fixture.response(client), b"")
            self.assertEqual(fixture.resolves, 0)

    def test_blocked_write_cleanup_closes_every_socket_and_worker(self):
        before = len(os.listdir("/proc/self/fd"))
        fixture = Fixture(echo=False)
        client = fixture.client();self.assertEqual(fixture.response(client), ESTABLISHED)
        client.setblocking(False)
        for _ in range(1024):
            try:client.send(b"x" * 16384)
            except BlockingIOError:break
        started = time.monotonic()
        fixture.close()
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)

    def test_shared_reservations_are_atomic_across_reader_threads(self):
        budget = Budget(replace(Limits(), aggregate_bytes=128))
        contexts=[];sockets=[]
        try:
            for _ in range(8):
                a,b=socket.socketpair();sockets.extend((a,b));contexts.append(Context(a,budget))
            barrier=threading.Barrier(33);success=[]
            def reserve(i):
                barrier.wait(timeout=2)
                try:budget.reserve(contexts[i%8],16);success.append(True)
                except Refused:success.append(False)
            readers=[threading.Thread(target=reserve,args=(i,)) for i in range(32)]
            for reader in readers:reader.start()
            barrier.wait(timeout=2)
            for reader in readers:reader.join(2);self.assertFalse(reader.is_alive())
            self.assertEqual(sum(success),8);self.assertEqual(budget.bytes,128)
        finally:
            for endpoint in sockets:endpoint.close()


if __name__ == "__main__":unittest.main()
