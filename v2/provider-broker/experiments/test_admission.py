"""Deterministic policy experiments, without provider processes or accounts."""
import unittest
from dataclasses import replace

from admission import Admission, Limits


class AdmissionExperiments(unittest.TestCase):
    def test_four_immediate_refusal_loses_a_short_startup_burst(self):
        policy = Admission(limits=replace(Limits(), active=4, pending=0))
        active = [policy.open(0) for _ in range(4)]
        self.assertEqual(policy.open(0.01).state, "queue_full")
        policy.finish(active[0], 0.30)
        # The already refused request is not replayed or retroactively admitted.
        self.assertEqual(len(policy.active), 3)

    def test_four_with_fifo_recovers_only_when_a_tunnel_drains(self):
        policy = Admission(limits=replace(Limits(), active=4))
        active = [policy.open(0) for _ in range(4)]
        waiting = [policy.open(0.01 * i) for i in range(1, 5)]
        for i, old in enumerate(active):
            policy.finish(old, 0.30 + 0.01 * i)
            self.assertEqual(waiting[i].state, "active")
        self.assertEqual(policy.peak_active, 4)

    def test_four_pooled_idle_connections_make_fifo_expire(self):
        policy = Admission(limits=replace(Limits(), active=4))
        active = [policy.open(0) for _ in range(4)]
        waiting = policy.open(0.01)
        policy.advance(2.01)
        self.assertEqual(waiting.state, "queue_expired")
        self.assertTrue(all(t.state == "active" for t in active))
        self.assertFalse(policy.reserve(waiting, 1, 2.01))

    def test_eight_admits_observed_shape_without_evicting_four_old_tunnels(self):
        policy = Admission()
        old = [policy.open(0) for _ in range(4)]
        startup = [policy.open(0.01) for _ in range(4)]
        self.assertTrue(all(t.state == "active" for t in old + startup))
        waiting = [policy.open(0.02) for _ in range(4)]
        self.assertTrue(all(t.state == "pending" for t in waiting))
        self.assertEqual(policy.open(0.02).state, "queue_full")
        self.assertEqual((policy.peak_active, policy.peak_pending), (8, 4))

    def test_eight_is_bounded_not_a_liveness_guarantee(self):
        policy = Admission()
        active = [policy.open(0) for _ in range(8)]
        waiting = policy.open(0)
        policy.advance(2)
        self.assertEqual(waiting.state, "queue_expired")
        # A silent tunnel may be a slow valid response, not an idle pool entry.
        self.assertTrue(policy.reserve(active[0], 256, 2.1))
        self.assertTrue(all(t.state == "active" for t in active))

    def test_fifo_newcomers_cannot_jump_existing_waiters(self):
        policy = Admission(limits=replace(Limits(), active=1))
        first = policy.open(0)
        second, third = policy.open(0.1), policy.open(0.2)
        policy.finish(first, 0.3)
        fourth = policy.open(0.3)
        self.assertEqual(second.state, "active")
        policy.finish(second, 0.4)
        self.assertEqual(third.state, "active")
        self.assertEqual(fourth.state, "pending")

    def test_cancelled_or_expired_head_does_not_block_successor(self):
        policy = Admission(limits=replace(Limits(), active=1))
        first, second, third = policy.open(0), policy.open(0.1), policy.open(0.2)
        policy.finish(second, 0.3, "cancelled")
        policy.finish(first, 0.4)
        self.assertEqual(third.state, "active")
        policy.finish(third, 0.4)
        fourth, fifth = policy.open(0.4), policy.open(0.5)
        sixth = policy.open(0.6)
        policy.finish(fourth, 2.5)
        self.assertEqual(fifth.state, "queue_expired")
        self.assertEqual(sixth.state, "active")

    def test_deadline_is_not_extended_by_new_requests_or_activity(self):
        policy = Admission(limits=replace(Limits(), active=1))
        active, waiting = policy.open(0), policy.open(0)
        for moment in (0.5, 1, 1.5):
            self.assertTrue(policy.reserve(active, 1, moment))
        policy.finish(active, 2)
        self.assertEqual(waiting.state, "queue_expired")

    def test_aggregate_bytes_cover_both_directions_and_sequential_tunnels(self):
        policy = Admission(limits=replace(Limits(), aggregate_bytes=10))
        first = policy.open(0)
        self.assertTrue(policy.reserve(first, 4, 0))  # client to upstream
        self.assertTrue(policy.reserve(first, 3, 0))  # upstream to client
        policy.finish(first, 0)
        second, pending = policy.open(0), policy.open(0)
        self.assertTrue(policy.reserve(second, 3, 0))
        self.assertFalse(policy.reserve(second, 1, 0))
        self.assertEqual(policy.bytes_reserved, 10)
        self.assertEqual(pending.state, "aggregate_bytes_exhausted")
        self.assertIsNone(policy.open(0))

    def test_tunnel_byte_cap_does_not_reset_aggregate_budget(self):
        policy = Admission(limits=replace(Limits(), tunnel_bytes=5))
        first = policy.open(0)
        self.assertTrue(policy.reserve(first, 5, 0))
        self.assertFalse(policy.reserve(first, 1, 0))
        self.assertEqual(first.state, "tunnel_bytes_exhausted")
        self.assertEqual(policy.bytes_reserved, 5)

    def test_attempt_budget_counts_refused_requests_without_unbounded_history(self):
        policy = Admission(limits=replace(Limits(), active=1, pending=0, requests=3))
        first = policy.open(0)
        self.assertEqual(policy.open(0).state, "queue_full")
        self.assertEqual(policy.open(0).state, "queue_full")
        policy.finish(first, 0)
        for _ in range(100):
            self.assertIsNone(policy.open(0))
        self.assertEqual(policy.requests, 3)

    def test_lifetime_and_tunnel_deadlines_are_distinct_and_not_replenished(self):
        policy = Admission(limits=replace(Limits(), lifetime_seconds=9, tunnel_seconds=4))
        first = policy.open(0)
        policy.advance(4)
        self.assertEqual(first.state, "tunnel_expired")
        second = policy.open(6)
        policy.advance(9)
        self.assertEqual(second.state, "lifetime_expired")
        self.assertIsNone(policy.open(9))

    def test_controller_cancellation_closes_active_and_pending_without_replay(self):
        policy = Admission(limits=replace(Limits(), active=1))
        active, pending = policy.open(0), policy.open(0)
        policy.close()
        self.assertEqual((active.state, pending.state), ("cancelled", "cancelled"))
        self.assertIsNone(policy.open(1))
        self.assertFalse(policy.reserve(active, 1, 1))


if __name__ == "__main__":
    unittest.main()
