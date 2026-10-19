"""Deterministic trace ordering when refusal interrupts the synthetic sender."""
import unittest

from worker_tool_peer import send_tool_request


class InterruptedSend(BaseException):
    pass


class ToolRequestTraceTests(unittest.TestCase):
    def test_interrupted_send_preserves_intent_without_emission_claim(self):
        rows = []

        def emit(frame):
            self.assertEqual(frame["params"]["tool"], "arbitrary_shell_is_forbidden")
            raise InterruptedSend()

        with self.assertRaises(InterruptedSend):
            send_tool_request(lambda kind, **fields: rows.append((kind, fields)), emit,
                              "tool:synthetic", "offline-python:1",
                              {"tool": "arbitrary_shell_is_forbidden"}, "print(42)")
        self.assertEqual([kind for kind, _ in rows], ["tool-request-intent"])
        self.assertEqual(rows[0][1]["request_id"], "tool:synthetic")

    def test_successful_send_keeps_distinct_ordered_markers(self):
        events = []
        send_tool_request(lambda kind, **fields: events.append(kind),
                          lambda frame: events.append("send-returned"),
                          "tool:synthetic", "offline-python:1", {}, "print(42)")
        self.assertEqual(events, ["tool-request-intent", "send-returned", "tool-request"])


if __name__ == "__main__":
    unittest.main()
