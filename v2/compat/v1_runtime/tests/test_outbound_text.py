"""Chat-safe outbound text: whole-sentence progress, single question header, no server paths."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import worker as worker_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.outbound_text import PROGRESS_HOLD_S, PROGRESS_SETTLE_S, complete_progress, scrub_local_paths
from v2.compat.v1_runtime.questions import QUESTION_LABEL, QUESTION_PREFIX
from v2.compat.v1_runtime.tests.test_worker import Peer
from v2.compat.v1_runtime.worker import Worker

QUESTION = "b2000000-0000-4000-8000-000000000001"


class ProgressBoundaryTests(unittest.TestCase):
    def test_fragments_seen_in_real_chats_are_incomplete(self):
        for text in ("There are two", "**Plan: about", "The author details and", "I've drafted", "The $20",
                     "Hosting", "I'll pass that", "I'll add Frost", "- **", "Next steps:", "  "):
            with self.subTest(text=text):
                self.assertFalse(complete_progress(text))

    def test_sentence_and_paragraph_ends_are_complete(self):
        for text in ("Checked the inbox.", "**Done.**", "Is that right?", "(see above.)", "Ok!\n",
                     "First paragraph\n\n", "Waiting…"):
            with self.subTest(text=text):
                self.assertTrue(complete_progress(text))


class LocalPathTests(unittest.TestCase):
    def test_markdown_links_to_local_files_become_file_names(self):
        text = ("Here: [Editable PowerPoint](/var/lib/orkestr-v2-pilot/workspace/c1/out/deck.pptx) "
                "and the [report](</home/orkestr/work/My Report.pdf>).")
        self.assertEqual(scrub_local_paths(text),
                         "Here: Editable PowerPoint: deck.pptx (not attached) and the report: My Report.pdf (not attached).")

    def test_link_target_with_spaces_and_parentheses_keeps_its_whole_name(self):
        self.assertEqual(scrub_local_paths("[CV](/home/o/My File (1).pdf) ok"), "CV: My File (1).pdf (not attached) ok")

    def test_bare_paths_ending_in_a_file_lose_their_directories(self):
        out = scrub_local_paths("Saved to /home/orkestr/work/cv.pdf. Also (/tmp/build/log.txt) and file:///srv/x/a.csv")
        self.assertEqual(out, "Saved to cv.pdf (not attached). Also (log.txt (not attached)) and a.csv (not attached)")

    def test_bare_path_with_spaces_never_leaks_its_directories(self):
        # Without link brackets the end of a spaced name is ambiguous; the
        # folder part is still replaced, so no server directory leaks.
        out = scrub_local_paths("It is /home/o/My File (1).pdf on disk.")
        self.assertNotIn("/home/", out)

    def test_folder_paths_and_extensionless_files_become_server_folder_names(self):
        self.assertEqual(scrub_local_paths("Logs are in /var/log/orkestr. Work in /home/orkestr/work/, see /etc/hostname"),
                         "Logs are in the server folder orkestr. Work in the server folder work, see the server folder hostname")
        self.assertEqual(scrub_local_paths("[logs](/var/log/app) and [deck](/home/o/d.pptx)"),
                         "logs (the server folder app) and deck: d.pptx (not attached)")
        self.assertEqual(scrub_local_paths("Cache: /opt/x/cache, /srv/site, /tmp/run1 and /root/.config"),
                         "Cache: the server folder cache, the server folder site, the server folder run1 and "
                         "the server folder .config")

    def test_routes_urls_and_other_roots_are_kept(self):
        for text in ("POST /run/start then GET /data/items/1", "GET /data/items/1.json", "DELETE /home/sessions/7",
                     "call /api/v1/files/report.pdf", "See https://example.com/home/user/a.pdf or ./home/x.pdf",
                     "Uses /usr/lib/python3.11 now", "/usr/local/bin is on PATH", "just /etc alone"):
            with self.subTest(text=text):
                self.assertEqual(scrub_local_paths(text), text)

    def test_code_is_never_touched(self):
        for text in ("Edit `/etc/nginx/nginx.conf` and reload.", "Run:\n```sh\nls /usr/local/bin\ncat /tmp/a/b.txt\n```\n",
                     "~~~\n[x](/home/o/a.pdf)\n~~~", "``/home/o/a `b` c.txt``"):
            with self.subTest(text=text):
                self.assertEqual(scrub_local_paths(text), text)
        self.assertEqual(scrub_local_paths("`/etc/a.conf` then /home/o/b.pdf"), "`/etc/a.conf` then b.pdf (not attached)")
        self.assertEqual(scrub_local_paths("```\n/tmp/a.txt\n```\nSee /tmp/b.txt"), "```\n/tmp/a.txt\n```\nSee b.txt (not attached)")


class WorkerOutboundTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.data = self.ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                             accountId="account", text="request"))[0]
        self.data["admitted_at"] = 0
        self.peer, self.texts = Peer(), {}
        original = self.peer.request

        def request(method, route, **kwargs):
            payload = route.rsplit("/", 1)[-1]
            if route.startswith("/payloads/") and payload in self.texts:
                return 200, dict(run_id="deep-run", payload_id=payload, text=self.texts[payload])
            return original(method, route, **kwargs)
        self.peer.request = request
        self.worker = Worker(self.peer, self.ledger, progress_updates=True)

    def progress(self, payload_id, at):
        status = dict(run_id="deep-run", phase="running", progress=dict(payload_id=payload_id))
        with patch.object(worker_module, "PROGRESS_INTERVAL_S", 0), patch("time.time", return_value=at):
            self.worker.capture_progress(self.data, status, {"deep-run"})
        return [m["text"] for m in self.ledger.messages() if m.get("kind") == "progress"]

    def test_fragment_is_held_and_superseded_by_the_complete_snapshot(self):
        self.texts.update(p1="There are two", p2="There are two options. I'll compare them.")
        self.assertEqual(self.progress("p1", 100), [])
        self.assertEqual(self.progress("p1", 105), [])
        self.assertEqual(self.progress("p2", 110), [])
        self.assertEqual(self.progress("p2", 110 + PROGRESS_SETTLE_S), ["There are two options. I'll compare them."])

    def test_complete_snapshot_settles_before_it_is_progress(self):
        self.texts.update(p1="Here is the schedule.")
        self.assertEqual(self.progress("p1", 100), [])
        self.assertEqual(self.progress("p1", 100 + PROGRESS_SETTLE_S - 1), [])
        self.assertEqual(self.progress("p1", 100 + PROGRESS_SETTLE_S), ["Here is the schedule."])
        self.assertEqual(self.progress("p1", 200), ["Here is the schedule."])

    def test_complete_snapshot_overtaken_by_the_final_is_never_progress(self):
        self.texts.update(p1="Here is the schedule.")
        self.assertEqual(self.progress("p1", 100), [])
        self.assertEqual(self.final("Here is the schedule."), "Here is the schedule.")
        self.assertEqual([m["text"] for m in self.ledger.messages() if m["role"] == "assistant"],
                         ["Here is the schedule."])

    def test_fragment_that_stays_latest_is_exported_once_finished(self):
        self.texts.update(p1="Checking the CRM entries now")
        self.assertEqual(self.progress("p1", 100), [])
        self.assertEqual(self.progress("p1", 100 + PROGRESS_HOLD_S - 1), [])
        self.assertEqual(self.progress("p1", 100 + PROGRESS_HOLD_S), ["Checking the CRM entries now"])
        self.assertEqual(self.progress("p1", 200), ["Checking the CRM entries now"])

    def test_progress_that_adds_more_than_the_question_is_kept(self):
        self.texts[QUESTION] = QUESTION_PREFIX + "Should I send the invoice to Anna?"
        self.texts["p1"] = "Should I send the invoice to Anna? Meanwhile I am drafting the cover letter."
        self.texts["p2"] = "Question: should I send the invoice to Anna?"
        self.progress(QUESTION, 100)
        self.assertEqual(self.progress("p2", 200), [])
        self.assertEqual(self.progress("p1", 300), [])
        self.assertEqual(self.progress("p1", 300 + PROGRESS_SETTLE_S), [self.texts["p1"]])

    def test_question_post_has_one_header_and_is_not_repeated_as_progress(self):
        self.texts[QUESTION] = QUESTION_PREFIX + "Should I send the invoice to Anna or to the office address?"
        self.texts["p1"] = "Should I send the invoice to Anna or to the office address?"
        self.assertEqual(self.progress(QUESTION, 100), [])
        posts = [m for m in self.ledger.messages() if m.get("postAuthor") == "assistant_question"]
        self.assertEqual([m["text"] for m in posts], [QUESTION_LABEL])  # V1 renders "❓ Question:" from this
        reply = [m for m in self.ledger.messages() if m.get("parentMessageId") == posts[0]["id"]]
        self.assertEqual([m["text"] for m in reply], ["Should I send the invoice to Anna or to the office address?"])
        # The same question in a commentary item never becomes a second post.
        self.assertEqual(self.progress("p1", 200), [])

    def final(self, text):
        self.ledger.complete(self.data, {"id": "final-reply", "role": "assistant", "state": "completed",
                                         "phase": "final_answer", "parentMessageId": self.data["remote_id"], "text": text})
        return self.ledger.messages()[-1]["text"]

    def test_shared_chat_final_never_carries_a_server_path_even_on_replay(self):
        self.ledger.scrub_paths = True
        text = "Done: [Editable PowerPoint](/var/lib/orkestr-v2-pilot/workspace/a/deck.pptx)"
        self.assertEqual(self.final(text), "Done: Editable PowerPoint: deck.pptx (not attached)")
        stored = self.ledger.input(self.data["remote_id"])
        self.assertNotIn("/var/lib", str(stored))  # The saved reply replays scrubbed text.
        with self.ledger.connect() as db:
            self.assertNotIn("/var/lib", str(db.execute("SELECT message FROM exports").fetchall()))

    def test_owner_only_chat_with_a_member_is_scrubbed_end_to_end(self):
        from types import SimpleNamespace
        from v2.compat.v1_runtime.registry import Registry
        binding = SimpleNamespace(worker=self.worker, ledger=self.ledger, thread=True, config=dict(
            progress_updates=False, fast_reply_policy="owner_only", attachments=False,
            participants=[{"ids": ["491700000001@c.us"], "label": "Ayse", "role": "member"}],
            max_input_age_seconds=60, instructions_path=None, auto_steer=None, owner_only_verified=True))
        with patch("v2.compat.v1_runtime.registry.auto_steer_mode", return_value=None):
            Registry._start(SimpleNamespace(workers=False), binding)
        self.assertTrue(self.ledger.owner_only, "owner_only Fast intake is kept")
        text = "Done: [deck](/var/lib/orkestr-v2-pilot/workspace/a/deck.pptx)"
        self.assertEqual(self.final(text), "Done: deck: deck.pptx (not attached)")

    def test_owner_only_chat_keeps_paths(self):
        text = "Done: [deck](/var/lib/orkestr-v2-pilot/workspace/a/deck.pptx) in /home/orkestr/work/"
        self.assertEqual(self.final(text), text)

    def test_shared_chat_folder_paths_are_rewritten(self):
        self.ledger.scrub_paths = True
        self.assertEqual(self.final("Saved under /home/orkestr/work/deck-v2/ (run `ls /home/orkestr/work`)."),
                         "Saved under the server folder deck-v2 (run `ls /home/orkestr/work`).")

    def test_registry_scrubs_every_chat_unless_marked_owner_only_verified(self):
        from types import SimpleNamespace
        from v2.compat.v1_runtime.registry import Registry
        # Scrubbed by default: fast_reply_policy alone (owner_only too) does not
        # establish that only the owner reads the group. Only an explicit
        # `owner_only_verified: true` with no listed participant keeps paths.
        member = {"ids": ["491700000001@c.us"], "label": "Ayse", "role": "member"}
        silent = {"ids": ["491700000002@c.us"], "label": "Ben", "role": "none"}
        absent = object()
        cases = (("owner_only", [], absent, True), ("owner_only", [], False, True),
                 ("owner_only", [], True, False), ("owner_only", [member], True, True),
                 ("owner_only", [silent], True, True), ("owner_only", [member], absent, True),
                 ("legacy", [], absent, True), ("legacy", [], True, False), ("disabled", [], absent, True),
                 ("legacy", [member], True, True), ("owner_only", [], "true", True))
        for policy, members, verified, expected in cases:
            with self.subTest(policy=policy, members=members, verified=verified):
                ledger = SimpleNamespace(owner_only=None, scrub_paths=None)
                config = dict(progress_updates=False, fast_reply_policy=policy, participants=members, attachments=False,
                              max_input_age_seconds=60, instructions_path=None, auto_steer=None)
                if verified is not absent:
                    config["owner_only_verified"] = verified
                binding = SimpleNamespace(worker=self.worker, ledger=ledger, thread=True, config=config)
                with patch("v2.compat.v1_runtime.registry.auto_steer_mode", return_value=None):
                    Registry._start(SimpleNamespace(workers=False), binding)
                self.assertIs(ledger.scrub_paths, expected)
                self.assertIs(ledger.owner_only, policy == "owner_only", "Fast policy is unchanged")

    def test_owner_only_verified_is_optional_boolean_and_defaults_to_scrubbed(self):
        from v2.compat.v1_runtime.config import binding as validate_binding
        from v2.compat.v1_runtime.registry import scrubs_paths
        owner, conversation, remote = ("00000000-0000-4000-8000-00000000000%d" % n for n in (1, 2, 3))
        base = dict(conversation_id=conversation, public_thread_id="t", chat_id="c", account_id="a",
                    remote_thread_id=remote, allowed_principals=["p"], excluded_public_ids=[],
                    automatic_accept_roles=["fast", "deep"], outbound_role="deep", enabled=True, revoked=False,
                    progress_updates=False, attachments=False, max_outstanding_inputs=8,
                    fast_reply_policy="owner_only")
        legacy_file = validate_binding(dict(base), owner)
        self.assertIs(legacy_file["owner_only_verified"], False, "a binding without the field is scrubbed")
        self.assertTrue(scrubs_paths(legacy_file))
        self.assertFalse(scrubs_paths(validate_binding(dict(base, owner_only_verified=True), owner)))
        for bad in ("true", 1, None):
            with self.subTest(value=bad), self.assertRaisesRegex(ValueError, "config_activation"):
                validate_binding(dict(base, owner_only_verified=bad), owner)

    def test_owner_only_verified_change_applies_on_reload(self):
        from v2.compat.v1_runtime.registry import MUTABLE_KEYS
        self.assertIn("owner_only_verified", MUTABLE_KEYS)

if __name__ == "__main__":
    unittest.main()
