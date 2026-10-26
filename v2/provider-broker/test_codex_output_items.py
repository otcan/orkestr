"""Item evidence survives the owned broker; it never supplies dispatch authority."""
import copy
import unittest
from protocol import Refused
from test_protocol import opened, ready, request, turn


def active():
    channel, _ = opened()
    ready(channel)
    request(channel, turn(), "CommitExecution", 6)
    channel.provider({"id": 4, "result": {"turn": {"id": "synthetic-turn", "status": "inProgress"}}})
    return channel


def item(method="item/completed", phase="final_answer"):
    return {"method": method, "params": {"threadId": "synthetic-native",
        "turnId": "synthetic-turn", "item": {"type": "agentMessage",
        "id": "answer", "text": "Whole answer.", "phase": phase,
        "memoryCitation": {"unrelated": "not forwarded"}}}}


class OutputItems(unittest.TestCase):
    def test_bound_item_identity_phase_and_text_survive_without_other_metadata(self):
        for phase in (None, "commentary", "partial_answer", "final_answer"):
            channel = active()
            clean = channel.provider(item(phase=phase))["params"]["frame"]
            self.assertEqual(clean["params"]["item"], {"type": "agentMessage",
                "id": "answer", "text": "Whole answer.", "phase": phase})
            self.assertFalse(channel.terminal)
            frame = {"method": "item/agentMessage/delta", "params": {
                "threadId": "synthetic-native", "turnId": "synthetic-turn",
                "itemId": "answer", "delta": ".", "unrelated": "discarded"}}
            clean = channel.provider(frame)["params"]["frame"]["params"]
            self.assertEqual(clean["itemId"], "answer")
            self.assertNotIn("unrelated", clean)

    def test_async_question_delivery_survives_and_unknown_delivery_refuses(self):
        frame = item()
        frame["params"]["item"]["delivery"] = "async"
        frame["params"]["item"]["questions"] = [{"title": "Which period?"}]
        clean = active().provider(frame)["params"]["frame"]["params"]["item"]
        self.assertEqual(clean, {"type": "agentMessage", "id": "answer", "text": "Whole answer.",
                                 "phase": "final_answer", "delivery": "async"})
        frame["params"]["item"]["delivery"] = "later"
        with self.assertRaises(Refused):
            active().provider(frame)

    def test_terminal_summary_retains_only_bounded_agent_items(self):
        channel = active()
        frame = {"method": "turn/completed", "params": {"threadId": "synthetic-native",
            "turn": {"id": "synthetic-turn", "status": "completed", "itemsView": "summary",
                "items": [item()["params"]["item"], {"type": "commandExecution", "command": "discarded"}]}}}
        clean = channel.provider(frame)["params"]["frame"]["params"]["turn"]
        self.assertEqual(clean["itemsView"], "summary")
        self.assertEqual(clean["items"], [{"type": "agentMessage", "id": "answer",
            "text": "Whole answer.", "phase": "final_answer"}])

    def test_item_metadata_does_not_bypass_commit_thread_turn_or_terminal_fences(self):
        channel, _ = opened()
        ready(channel)
        with self.assertRaises(Refused):
            channel.provider(item())
        for key in ("threadId", "turnId"):
            frame = item()
            frame["params"][key] = "foreign"
            with self.assertRaises(Refused):
                active().provider(frame)
        channel = active()
        channel.provider({"method": "turn/completed", "params": {
            "threadId": "synthetic-native", "turn": {"id": "synthetic-turn", "status": "completed"}}})
        with self.assertRaises(Refused):
            channel.provider(item())

    def test_invalid_item_fields_and_summary_bounds_refuse(self):
        for key, value in (("id", ""), ("id", "x" * 513), ("text", 1),
                           ("text", "🦀" * 2049), ("phase", "analysis"), ("phase", False)):
            frame = item()
            frame["params"]["item"][key] = value
            with self.subTest(key=key), self.assertRaises(Refused):
                active().provider(frame)
        for items, view in (({}, "full"), ([{}] * 129, "summary"), ([], "unknown")):
            frame = {"method": "turn/completed", "params": {"threadId": "synthetic-native",
                "turn": {"id": "synthetic-turn", "status": "completed", "items": items, "itemsView": view}}}
            with self.assertRaises(Refused):
                active().provider(frame)

    def test_non_agent_items_never_become_tool_authority(self):
        channel = active()
        frame = item()
        frame["params"]["item"] = {"type": "commandExecution", "command": "untrusted"}
        # The first model item yields only a closed activity marker (no item
        # content) for Runtime's stall watchdog; later ones nothing at all.
        marker = channel.provider(frame)["params"]["frame"]
        self.assertEqual(marker, {"method": "turn/activity", "params": {
            "threadId": "synthetic-native", "turnId": "synthetic-turn"}})
        self.assertIsNone(channel.provider(frame))
        self.assertFalse(channel.terminal)
        self.assertIsNone(channel.pending)
        denied = copy.deepcopy(frame)
        denied["method"] = "item/tool/call"
        with self.assertRaises(Refused):
            channel.provider(denied)


if __name__ == "__main__":
    unittest.main()
