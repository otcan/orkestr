"""Item evidence survives the owned broker; it never supplies dispatch authority."""
import copy
import json
import pathlib
import unittest
from protocol import CLIPPED_NOTE, MAX_FRAME, MAX_REPLY_BYTES, Refused, clip_utf8, encode
from test_protocol import opened, ready, request, turn

RUNTIME_CLIP = (pathlib.Path(__file__).resolve().parent.parent
                / "crates/orkestr-runtime/src/codex_rpc/turn/clip.rs")


def turkish_reply(size=8211):
    """Synthetic Turkish prose of exactly `size` UTF-8 bytes. Its letters take
    two bytes, so far fewer characters than bytes reach the 8 KiB bound; byte
    8,192 falls inside a two-byte letter."""
    sentence = "Çalışma planı güncellendi; bütçe, iş paketleri ve ölçütler şöyle sıralandı. "
    text = "."
    while len((text + sentence).encode()) <= size:
        text += sentence
    for letter in sentence:
        if len((text + letter).encode()) > size:
            break
        text += letter
    text += "." * (size - len(text.encode()))
    assert len(text.encode()) == size and len(text) < size
    return text


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
                           ("phase", "analysis"), ("phase", False)):
            frame = item()
            frame["params"]["item"][key] = value
            with self.subTest(key=key), self.assertRaises(Refused):
                active().provider(frame)
        for items, view in (({}, "full"), ([{}] * 129, "summary"), ([], "unknown")):
            frame = {"method": "turn/completed", "params": {"threadId": "synthetic-native",
                "turn": {"id": "synthetic-turn", "status": "completed", "items": items, "itemsView": view}}}
            with self.assertRaises(Refused):
                active().provider(frame)

    def test_reply_over_the_bound_is_cut_on_a_character_boundary_and_marked(self):
        full = turkish_reply()
        kept = full.encode()[:MAX_REPLY_BYTES].decode("utf-8", "ignore")
        frame = item()
        frame["params"]["item"]["text"] = full
        channel = active()
        output = channel.provider(frame)
        clean = output["params"]["frame"]["params"]["item"]
        self.assertEqual(clean, {"type": "agentMessage", "id": "answer", "text": kept,
                                 "phase": "final_answer", "clipped": True})
        # Byte 8,192 is inside a letter: the cut keeps the whole letters before it.
        self.assertEqual(len(clean["text"].encode()), MAX_REPLY_BYTES - 1)
        self.assertTrue(full.startswith(clean["text"]))
        self.assertFalse(channel.terminal)
        # The escaped broker frame still fits the transport bound.
        self.assertLessEqual(len(encode(output)), MAX_FRAME + 1)
        terminal = {"method": "turn/completed", "params": {"threadId": "synthetic-native",
            "turn": {"id": "synthetic-turn", "status": "completed", "itemsView": "full",
                     "items": [frame["params"]["item"]]}}}
        items = channel.provider(terminal)["params"]["frame"]["params"]["turn"]["items"]
        self.assertEqual(items, [clean])

    def test_clip_utf8_keeps_text_within_the_bound_unchanged(self):
        for text in ("", "Whole answer.", "ş" * (MAX_REPLY_BYTES // 2), "x" * MAX_REPLY_BYTES):
            self.assertEqual(clip_utf8(text), (text, False))
        sample = "aş🦀ı"  # 1 + 2 + 4 + 2 bytes
        for size, expected in ((1, "a"), (2, "a"), (3, "aş"), (6, "aş"), (7, "aş🦀"), (8, "aş🦀")):
            self.assertEqual(clip_utf8(sample, size), (expected, True))
        self.assertEqual(clip_utf8(sample, 9), (sample, False))

    def test_runtime_appends_the_same_note(self):
        if not RUNTIME_CLIP.exists():
            self.skipTest("Runtime source is not part of this tree")
        self.assertIn(json.dumps(CLIPPED_NOTE), RUNTIME_CLIP.read_text())

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
