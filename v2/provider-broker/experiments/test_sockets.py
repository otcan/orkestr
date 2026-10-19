"""Local OS sockets exercise the model's concurrency, byte and cleanup claims."""
import os
import threading
import unittest
from dataclasses import replace

from admission import Limits
from socket_harness import CHUNK, SocketHarness


class SocketExperiments(unittest.TestCase):
    def test_short_burst_waits_then_transfers_in_fifo_order(self):
        with SocketHarness(replace(Limits(), active=4)) as harness:
            active = [harness.request() for _ in range(4)]
            queued = [harness.request() for _ in range(4)]
            for channel in queued:
                self.assertIsNone(channel.upstream)
                channel.client.sendall(b"opaque fixture")
            for old, waiting in zip(active, queued):
                old.peer.close()
                harness.wait(lambda: waiting.peer is not None)
                self.assertEqual(waiting.peer.recv(14), b"opaque fixture")
                waiting.peer.sendall(b"response")
                self.assertEqual(waiting.client.recv(8), b"response")
            self.assertEqual(harness.policy.peak_active, 4)
            self.assertLessEqual(harness.peak_owned_sockets, 12)

    def test_quiet_pool_and_slow_response_are_indistinguishable_until_data_arrives(self):
        with SocketHarness(replace(Limits(), active=4)) as harness:
            quiet = [harness.request() for _ in range(4)]
            waiting = harness.request()
            for channel in quiet:
                channel.client.sendall(b"request")
                self.assertEqual(channel.peer.recv(7), b"request")
            harness.advance(2)
            self.assertEqual(waiting.ticket.state, "queue_expired")
            self.assertEqual(waiting.client.recv(1), b"")
            # No bytes during the wait distinguish pooled idle from valid work.
            quiet[0].peer.sendall(b"legitimate delayed result")
            self.assertEqual(quiet[0].client.recv(25), b"legitimate delayed result")
            self.assertTrue(all(c.ticket.state == "active" for c in quiet))

    def test_eight_plus_four_queue_uses_at_most_twenty_owned_stream_sockets(self):
        with SocketHarness() as harness:
            active = [harness.request() for _ in range(8)]
            queued = [harness.request() for _ in range(4)]
            refused = harness.request()
            self.assertEqual(refused.client.recv(1), b"")
            self.assertEqual(harness.peak_owned_sockets, 20)
            self.assertEqual((harness.policy.peak_active, harness.policy.peak_pending), (8, 4))
            for i, channel in enumerate(active):
                payload = bytes([i]) * 1024
                channel.client.sendall(payload)
                self.assertEqual(channel.peer.recv(1024), payload)
            self.assertTrue(all(c.peer is None for c in queued))
            self.assertLessEqual(harness.peak_buffered, 2 * 8 * CHUNK)

    def test_aggregate_exhaustion_cannot_replenish_after_a_new_connection(self):
        with SocketHarness(replace(Limits(), aggregate_bytes=12)) as harness:
            first = harness.request()
            first.client.sendall(b"123456")
            self.assertEqual(first.peer.recv(6), b"123456")
            first.peer.sendall(b"789")
            self.assertEqual(first.client.recv(3), b"789")
            harness.cancel(first)
            second = harness.request()
            second.client.sendall(b"abc")
            self.assertEqual(second.peer.recv(3), b"abc")
            second.client.sendall(b"over budget")
            harness.wait(lambda: harness.policy.closed)
            self.assertEqual(second.peer.recv(1), b"")
            self.assertEqual(harness.forwarded, 12)
            self.assertIsNone(harness.request())

    def test_simultaneous_attempts_obey_caps_and_cleanup_all_sockets(self):
        baseline_fds = len(os.listdir("/proc/self/fd"))
        harness = SocketHarness()
        try:
            barrier = threading.Barrier(17)
            results = []

            def request():
                barrier.wait(timeout=2)
                results.append(harness.request())

            clients = [threading.Thread(target=request) for _ in range(16)]
            for thread in clients:
                thread.start()
            barrier.wait(timeout=2)
            for thread in clients:
                thread.join(2)
                self.assertFalse(thread.is_alive())
            self.assertEqual(len(results), 16)
            self.assertEqual(sum(c.ticket.state == "active" for c in results), 8)
            self.assertEqual(sum(c.ticket.state == "pending" for c in results), 4)
            self.assertEqual(sum(c.ticket.state == "queue_full" for c in results), 4)
            self.assertLessEqual(harness.peak_owned_sockets, 20)
        finally:
            harness.close()
        self.assertFalse(harness.thread.is_alive())
        self.assertEqual(len(os.listdir("/proc/self/fd")), baseline_fds)

    def test_pending_disconnect_is_bounded_and_cancel_releases_all_authority(self):
        with SocketHarness(replace(Limits(), active=1)) as harness:
            active, disconnected, waiting = (harness.request() for _ in range(3))
            disconnected.client.close()
            # This experiment conservatively retains an unread pending socket
            # until cancellation/deadline; it does not claim early FIN detection.
            harness.cancel(disconnected)
            harness.cancel(active)
            self.assertEqual(waiting.ticket.state, "active")
            harness.advance(900)
            self.assertEqual(waiting.ticket.state, "lifetime_expired")
            self.assertEqual(waiting.client.recv(1), b"")
            self.assertIsNone(harness.request())


if __name__ == "__main__":
    unittest.main()
