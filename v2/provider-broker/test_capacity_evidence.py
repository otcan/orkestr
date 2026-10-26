"""Capacity and side-effect evidence: closed booleans only, never provider text."""
import unittest
from protocol import capacity_error
from test_protocol import opened, ready, request, turn

NATIVE = "synthetic-native"
OVERLOADED = {"message": "Selected model is at capacity. Please try a different model.",
              "codexErrorInfo": "serverOverloaded", "additionalDetails": "private detail"}


def active():
    channel, _ = opened()
    ready(channel)
    request(channel, turn(), "CommitExecution", 6)
    channel.provider({"id": 4, "result": {"turn": {"id": "t1", "status": "inProgress"}}})
    return channel


def failed(channel, error=None, items=None):
    body = {"id": "t1", "status": "failed"}
    if error is not None:
        body["error"] = error
    if items is not None:
        body["items"] = items
    frame = channel.provider({"method": "turn/completed", "params": {"threadId": NATIVE, "turn": body}})
    return frame["params"]["frame"]["params"]["turn"]


def item(kind, method="item/started"):
    return {"method": method, "params": {"threadId": NATIVE, "turnId": "t1",
                                         "item": {"type": kind, "id": "i1"}}}


class CapacityEvidence(unittest.TestCase):
    def test_capacity_classes_are_closed(self):
        for error in (OVERLOADED, {"codex_error_info": "server_overloaded"},
                      {"codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": 429}}},
                      {"message": "The selected model is at capacity."}):
            self.assertTrue(capacity_error(error), error)
        for error in (None, "serverOverloaded", {"codexErrorInfo": "usageLimitExceeded"},
                      {"codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": 500}}},
                      {"message": "context window exceeded"}):
            self.assertFalse(capacity_error(error), error)

    def test_clean_capacity_failure_forwards_only_class_and_no_side_effects(self):
        channel = active()
        channel.provider({"method": "item/reasoning/summaryTextDelta", "params": {
            "threadId": NATIVE, "turnId": "t1", "delta": "thinking"}})
        channel.provider(item("reasoning"))
        channel.provider({"method": "thread/tokenUsage/updated", "params": {"threadId": NATIVE}})
        clean = failed(channel, OVERLOADED)
        self.assertEqual(clean, {"id": "t1", "status": "failed",
                                 "error": {"class": "capacity"}, "sideEffects": False})
        self.assertNotIn("private", str(clean))

    def test_error_notification_without_retry_marks_capacity(self):
        channel = active()
        channel.provider({"method": "error", "params": {"threadId": NATIVE, "turnId": "t1",
                                                        "willRetry": True, "error": OVERLOADED}})
        self.assertFalse(channel.capacity)
        channel.provider({"method": "error", "params": {"threadId": NATIVE, "turnId": "t1",
                                                        "willRetry": False, "error": OVERLOADED}})
        self.assertEqual(failed(channel)["error"], {"class": "capacity"})

    def test_any_tool_item_or_unknown_activity_is_a_side_effect(self):
        for frame in (item("commandExecution"), item("fileChange", "item/completed"),
                      item("mcpToolCall"), item("webSearch"), item("collabAgentToolCall"),
                      {"method": "item/commandExecution/outputDelta", "params": {"threadId": NATIVE}},
                      {"method": "turn/diff/updated", "params": {"threadId": NATIVE}},
                      {"method": "hook/started", "params": {"threadId": NATIVE}},
                      {"method": "thread/started", "params": {"threadId": "sub-agent"}}):
            channel = active()
            channel.provider(frame)
            with self.subTest(frame=frame["method"]):
                self.assertEqual(failed(channel, OVERLOADED)["sideEffects"], True)
        channel = active()
        clean = failed(channel, OVERLOADED, items=[{"type": "commandExecution", "id": "c"}])
        self.assertEqual(clean["sideEffects"], True)

    def test_non_capacity_failure_has_no_class_and_completed_is_unchanged(self):
        channel = active()
        self.assertEqual(failed(channel, {"codexErrorInfo": "usageLimitExceeded"}),
                         {"id": "t1", "status": "failed", "sideEffects": False})
        channel = active()
        frame = channel.provider({"method": "turn/completed", "params": {"threadId": NATIVE,
                                  "turn": {"id": "t1", "status": "completed", "error": OVERLOADED}}})
        self.assertEqual(frame["params"]["frame"]["params"]["turn"], {"id": "t1", "status": "completed"})

    def test_one_activity_marker_per_turn_and_never_for_the_user_message(self):
        channel = active()
        self.assertIsNone(channel.provider(item("userMessage")))
        marker = channel.provider(item("reasoning"))["params"]["frame"]
        self.assertEqual(marker, {"method": "turn/activity",
                                  "params": {"threadId": NATIVE, "turnId": "t1"}})
        self.assertIsNone(channel.provider(item("reasoning", "item/completed")))
        mismatched = active()
        other = item("reasoning")
        other["params"]["turnId"] = "other-turn"
        self.assertIsNone(mismatched.provider(other))

    def test_interrupted_terminal_carries_side_effect_evidence(self):
        channel = active()
        frame = channel.provider({"method": "turn/completed", "params": {"threadId": NATIVE,
                                  "turn": {"id": "t1", "status": "interrupted"}}})
        self.assertEqual(frame["params"]["frame"]["params"]["turn"],
                         {"id": "t1", "status": "interrupted", "sideEffects": False})

    def test_unknown_method_without_dict_params_is_a_side_effect(self):
        channel = active()
        channel.provider({"method": "deprecationNotice", "params": None})
        self.assertFalse(channel.side_effects)
        channel.provider({"method": "fs/changed", "params": ["x"]})
        self.assertTrue(channel.side_effects)

    def test_late_stall_interrupt_after_terminal_is_tolerated(self):
        channel = active()
        channel.provider({"method": "turn/completed", "params": {"threadId": NATIVE,
                          "turn": {"id": "t1", "status": "completed"}}})
        interrupt = {"id": 9, "method": "turn/interrupt",
                     "params": {"threadId": NATIVE, "turnId": "t1"}}
        forwarded, _ = request(channel, interrupt, "CancelExecution", 7)
        self.assertEqual(forwarded, interrupt)
        reply = channel.provider({"id": 9, "error": {"code": -32600, "message": "no active turn"}})
        self.assertEqual(reply["result"]["frame"], {"id": 9, "error": {"code": -32600}})
        self.assertIsNone(channel.pending)

    def test_evidence_resets_for_the_retry_turn(self):
        channel = active()
        channel.provider(item("commandExecution"))
        failed(channel, OVERLOADED)
        retry = turn()
        retry["id"] = 5
        retry["params"]["clientUserMessageId"] = "synthetic-message-retry"
        retry["params"]["model"] = "gpt-6-sol"
        request(channel, retry, "CommitExecution", 7)
        self.assertFalse(channel.side_effects or channel.capacity)
        self.assertEqual(channel.requested_model, "gpt-6-sol")


class FastFallbackStaysReadOnly(unittest.TestCase):
    """A Fast capacity retry is one more turn on the same read-only Fast
    thread of the Fast broker: no sandbox field exists on a turn."""

    def test_fast_retry_runs_on_the_same_read_only_channel(self):
        from protocol import FAST_SANDBOX, Refused
        from test_fast_read_only import FAST, opened as fast_opened, reply, start
        channel = fast_opened(FAST, fast_only=True)
        start(channel, "read-only")
        reply(channel, {"type": "readOnly", "networkAccess": False})
        first = turn()
        request(channel, first, "CommitExecution", 6)
        channel.provider({"id": 4, "result": {"turn": {"id": "t1", "status": "inProgress"}}})
        clean = failed(channel, OVERLOADED)
        self.assertEqual(clean["sideEffects"], False)
        widened = turn()
        widened["id"] = 5
        widened["params"]["clientUserMessageId"] = "synthetic-message-retry"
        widened["params"]["model"] = "gpt-6-sol"
        widened["params"]["sandboxPolicy"] = {"type": "dangerFullAccess"}
        with self.assertRaises(Refused):
            request(channel, widened, "CommitExecution", 7)
        channel = fast_opened(FAST, fast_only=True)
        start(channel, "read-only")
        reply(channel, {"type": "readOnly", "networkAccess": False})
        request(channel, turn(), "CommitExecution", 6)
        channel.provider({"id": 4, "result": {"turn": {"id": "t1", "status": "inProgress"}}})
        failed(channel, OVERLOADED)
        retry = turn()
        retry["id"] = 5
        retry["params"]["clientUserMessageId"] = "synthetic-message-retry"
        retry["params"]["model"] = "gpt-6-sol"
        request(channel, retry, "CommitExecution", 7)
        self.assertEqual(channel.sandbox, FAST_SANDBOX)
        self.assertEqual(channel.role, "fast")
        self.assertEqual(channel.requested_model, "gpt-6-sol")


if __name__ == "__main__":
    unittest.main()
