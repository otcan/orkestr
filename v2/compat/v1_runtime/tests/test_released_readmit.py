"""An input released by its own window is re-admitted at once while another window is open.

A window Core reconciles (abandon) or whose opening failed releases every input
no run consumed back to Core's inbox, where no later window picks it up. The
next window is usually another input's (often an earlier input's own
re-admission). Waiting the full RETIRE_WAIT_S for that window only ends in a
"Technical failure" notice; Core's retirement gate decides instead.

All IDs, texts and peers are synthetic; nothing here reaches a provider or
WhatsApp.
"""
import unittest

from v2.compat.v1_runtime import recovery
from v2.compat.v1_runtime.tests.test_p0_recovery import Base, FastOnlyPeer, NoRunPeer

OTHER_WINDOW = dict(window_id="other-input-window", state="active", conversation_id="conversation")


class ReleasedWhileAnotherWindowIsOpenTests(Base):
    peer_class = NoRunPeer

    def released(self):
        """Admit the input into its window; the window is reconciled before any
        run of the input started, and another input's window opens."""
        self.passes(1)
        data = self.ledger.next_input()
        data["unstarted_since"] -= 61
        self.ledger.save(data)
        self.peer.current = dict(OTHER_WINDOW)

    def test_released_input_is_readmitted_at_once_without_the_wait(self):
        self.released()
        self.peer.retire_state = "retired"  # Core proves nothing of it ran or can run.
        log = self.passes(1)
        data = self.ledger.next_input()
        self.assertEqual(data["readmitted"]["trigger"], "automatic")
        self.assertEqual(data["readmitted"]["reason"], "window_setup_failed")
        self.assertEqual(data["retired_original"]["message_id"], "message")
        self.assertNotIn("retry_wait_since", data, "no bounded wait was started")
        self.assertNotIn("input_waiting_for_core", log)
        self.assertNotIn("ALERT", log)
        self.assertEqual(self.retires(), ["/inputs/message/retire"])
        self.assertEqual(self.notices(), [])
        # The re-admitted turn runs and answers; the chat never saw a failure.
        self.peer.foreign, self.peer.current = False, None
        self.passes(2)
        self.assertEqual(self.ledger.messages()[-1]["text"], "deep result")
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.messages_sent(), 2)

    def test_core_releasing_it_during_the_wait_readmits_it_on_that_pass(self):
        self.released()
        log = self.passes(2)  # Core still owns it (retirement refused): wait.
        self.assertEqual(log.count("input_waiting_for_core"), 1)
        self.assertIn("wait=successor_open", log)
        self.assertNotIn("readmitted", self.ledger.next_input())
        self.peer.retire_state = "retired"
        self.passes(1)
        data = self.ledger.next_input()
        self.assertEqual(data["readmitted"]["trigger"], "automatic")
        self.assertNotIn("retry_wait_since", data)
        self.assertEqual(self.notices(), [])

    def test_refused_retirement_still_closes_after_the_bound(self):
        self.released()
        self.passes(1)
        data = self.ledger.next_input()
        data["retry_wait_since"] -= recovery.RETIRE_WAIT_S + 1
        self.ledger.save(data)
        log = self.passes(1)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["refused"]["reason"], "window_setup_failed")
        self.assertNotIn("readmitted", data)
        self.assertEqual(len(self.notices()), 1)
        self.assertIn("ALERT orkestr-v2-wa-adapter input_refused", log)
        self.assertEqual(self.messages_sent(), 1)

    def test_a_queued_window_request_for_it_is_never_retired(self):
        self.released()
        self.peer.window_queue = [dict(input_event_id="event", input_message_id="message", state="queued")]
        self.peer.retire_state = "retired"  # Real Core would refuse; the adapter must not even ask.
        log = self.passes(2)
        data = self.ledger.next_input()
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.retires(), [])
        self.assertIn("wait=successor_open", log)
        self.assertEqual(self.notices(), [])

    def test_an_owner_stop_is_honoured_and_never_retired(self):
        self.released()
        self.peer.held = ["message"]
        self.peer.retire_state = "retired"  # Real Core would still retire a held queued row.
        log = self.passes(1)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["settled"]["outcome"], "held")
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.retires(), [])
        self.assertEqual(self.notices(), [])
        self.assertIn("input_closed_owner_stop", log)

    def test_own_window_awaiting_reconciliation_still_waits(self):
        self.released()
        self.peer.current = dict(window_id="window", state="reconciliation_required", conversation_id="conversation")
        self.peer.retire_state = "retired"
        self.passes(2)
        data = self.ledger.next_input()
        self.assertEqual(data["phase"], "running")
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.retires(), [], "reconciliation may still release or run it")
        self.assertEqual(self.notices(), [])

    def test_exhausted_retries_still_close_with_the_plain_notice(self):
        self.released()
        data = self.ledger.next_input()
        data["readmitted"] = dict(attempt=len(recovery.RETRY_BACKOFF_S))
        self.ledger.save(data)
        self.peer.retire_state = "retired"
        self.passes(1)
        data = self.ledger.input(self.data["remote_id"])
        self.assertEqual(data["refused"]["reason"], "window_setup_failed")
        self.assertIn("setup_retries_exhausted", data)
        self.assertEqual(self.retires(), [])
        self.assertEqual(len(self.notices()), 1)


class RunReferencesTheInputTests(Base):
    """A run (here its Fast) references the message: Core never retires it."""
    peer_class = FastOnlyPeer

    def test_another_open_window_keeps_the_old_wait_and_never_asks_core(self):
        self.passes(1)
        data = self.ledger.next_input()
        data["deep_missing_since"] -= 61
        self.ledger.save(data)
        self.peer.current = dict(OTHER_WINDOW)
        self.peer.retire_state = "retired"
        log = self.passes(2)
        data = self.ledger.next_input()
        self.assertNotIn("readmitted", data)
        self.assertEqual(self.retires(), [])
        self.assertIn("wait=successor_open", log)


if __name__ == "__main__":
    unittest.main()
