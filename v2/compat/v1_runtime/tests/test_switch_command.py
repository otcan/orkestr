"""/switch: owner-only model switch handled by the adapter. Synthetic ids, a fake tool, no Rust or WhatsApp peer."""
import json
import os
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime import switch_command
from v2.compat.v1_runtime.switch_command import Invalid, Switcher, parse
from v2.compat.v1_runtime.worker import Signal

from test_ledger_server import Harness
from test_participants import HEADER, PHONE, with_participants

OTHER = "00000000-0000-4000-8000-00000000beef"


def chat(conversation, provider="codex", model="gpt-a", effort="medium", fast=("gpt-f", "low"), name="Chat"):
    return {"conversation": conversation, "name": name, "live": True, "provider": provider, "model": model,
            "effort": effort, "fast": {"model": fast[0], "effort": fast[1]} if fast else None, "recent": {}}


class FakeSwitcher(Switcher):
    """Answers like orkestr-model-switch; records every argument list."""

    def __init__(self, chats, history=()):
        super().__init__(tool="/nonexistent", records="/nonexistent")
        self.chats, self._history, self.calls = chats, list(history), []
        self.refuse = None

    def call(self, args, kind):
        self.calls.append(list(args))
        if args[:1] == ["--status"]:
            return 0, json.dumps({"deep": {"codex:gpt-a": 2}, "fast": {"gpt-f": 2},
                                  "global_codex_default": {"model": "gpt-a", "effort": "xhigh"},
                                  "switches_in_effect": [], "chats": self.chats}), ""
        if self.refuse:
            return 2, "", "refused: " + self.refuse
        if args[0] == "--revert":
            if args[1] == "latest" and not self._history:
                return 0, "nothing to revert: already on gpt-a (...). No switch is in effect; nothing changed.\n", ""
            plan = "plan: revert R1 (deep -> back) for 1 conversation(s)\n  Chat   codex:gpt-b/high -> codex:gpt-a/medium\n"
            return 0, plan + ("dry run: nothing changed\n" if "--dry-run" in args else
                              "applied: revert of R1: 1 restored, 0 skipped\nrecord: /r/R2.json\n"), ""
        layer, to = args[args.index("--layer") + 1], args[args.index("--to") + 1]
        provider = args[args.index("--provider") + 1] if "--provider" in args else None
        plan = "plan: %s -> %s for 1 conversation(s)%s\n  Chat   codex:gpt-a/medium -> %s:%s/medium\n" % (
            layer, to, " (PROVIDER SWITCH to %s)" % provider if provider else "", provider or "codex", to)
        if provider:
            plan += "WARNING: provider switch to %s: ...\n" % provider
            if "--yes" not in args and "--dry-run" not in args:
                return 2, "", "refused: provider switch needs --yes"
        if "--dry-run" in args:
            return 0, plan + "dry run: nothing changed\n", ""
        return 0, plan + "applied: %s -> %s, scope %s: 1 changed, 0 skipped\nrecord: /r/R9.json\n" % (
            layer, to, args[args.index("--scope") + 1]), ""

    def history(self):
        return self._history


class SwitchCommandTests(Harness):
    def setUp(self):
        super().setUp()
        self.conversation = self.binding(1).config["conversation_id"]
        self.tool = FakeSwitcher([chat(self.conversation), chat(OTHER, name="Other")])
        self.binding(1).worker.switcher = self.tool
        self.n = 0

    def send(self, text, body=None, n=1):
        self.n += 1
        body = body or self.body(n, text=text, publicMessageId="switch-%d" % self.n)
        status, value = self.post(n, body=body)
        self.assertEqual(status, 202, value)
        return value

    def answer(self, text, **kwargs):
        self.send(text, **kwargs)
        self.assertTrue(switch_command.drive(self.binding(1).worker))
        replies = [m for m in self.listing(1)["messages"] if m["role"] == "assistant"]
        return replies[-1]["text"]

    def applied(self):
        return [c for c in self.tool.calls if c[:1] != ["--status"] and "--dry-run" not in c]

    def test_the_command_is_consumed_and_answered_through_the_normal_export(self):
        self.send("/switch status")
        ledger = self.binding(1).ledger
        # Never offered to Fast, Deep, a burst or the queue head.
        self.assertIsNone(ledger.next_input())
        self.assertEqual(ledger.pending_inputs(), [])
        switch_command.drive(self.binding(1).worker)
        user, reply = self.listing(1)["messages"]
        self.assertEqual((user["role"], user["text"]), ("user", "/switch status"))
        self.assertEqual((reply["role"], reply["kind"], reply["phase"], reply["parentMessageId"]),
                         ("assistant", "notice", "final_answer", user["id"]))
        self.assertIn("Deep: codex gpt-a, effort medium", reply["text"])
        self.assertIn("Fast: gpt-f, effort low", reply["text"])
        self.assertIn("All live chats: Deep codex:gpt-a ×2", reply["text"])
        self.assertTrue(reply["text"].endswith(switch_command.FOOTER))
        self.assertEqual(self.tool.calls, [["--status", "--json"]])
        # Answered once: a second pass does nothing; the ack settles it as usual.
        self.assertFalse(switch_command.drive(self.binding(1).worker))
        self.assertEqual(self.ack(1, reply["id"], parent=user["publicMessageId"])[0], 200)
        self.assertEqual(self.listing(1)["messages"], [])

    def test_header_and_case_are_ignored_and_ordinary_text_is_not_a_command(self):
        self.assertIsNotNone(switch_command.command_text(HEADER + "/Switch status"))
        for text in ("switch to gpt", "/switchboard", "please /switch deep x", "/stop"):
            self.assertIsNone(switch_command.command_text(text))
        self.send("please /switch deep gpt-b")
        self.assertEqual(self.binding(1).ledger.next_input()["text"], "please /switch deep gpt-b")

    def test_deep_switch_defaults_to_this_chat_and_runs_a_dry_run_first(self):
        text = self.answer("/switch deep gpt-b high")
        dry, apply = self.tool.calls[1:]
        self.assertEqual(dry, ["--layer", "deep", "--to", "gpt-b", "--effort", "high", "--scope", self.conversation, "--dry-run"])
        self.assertEqual(apply[:8], dry[:8])
        self.assertIn("--reason", apply)
        self.assertNotIn("--dry-run", apply)
        self.assertIn("Chat: codex:gpt-a/medium → codex:gpt-b/medium", text)
        self.assertIn("/switch back to undo.", text)

    def test_fast_all_and_from_forms(self):
        self.answer("/switch fast gpt-c low all from gpt-f")
        self.assertEqual(self.applied()[0][:10], ["--layer", "fast", "--to", "gpt-c", "--effort", "low", "--scope", "codex",
                                                  "--from", "gpt-f"])
        text = self.answer("/switch deep default")
        self.assertEqual(self.applied()[1][:6], ["--layer", "deep", "--to", "default", "--scope", self.conversation])
        self.assertIn("/switch back to undo", text)

    def test_fable_and_malformed_models_are_refused_without_running_the_tool(self):
        for text in ("/switch deep claude-fable-5", "/switch deep gpt-b from FABLE", "/switch fast Fable"):
            self.assertIn("Fable models are not allowed", self.answer(text))
        for text in ("/switch deep", "/switch deep $(rm)", "/switch deep gpt-b sideways", "/switch claude opus",
                     "/switch fast gpt-b for claude", "/switch deep opus for claude"):
            self.assertIn("/switch status", self.answer(text))  # Reason plus help.
        self.assertEqual(self.tool.calls, [])

    def test_a_refusal_from_the_tool_dry_run_applies_nothing(self):
        self.tool.refuse = "model 'x' is not allowed by the V2 contract"
        self.assertIn("/switch refused: model 'x' is not allowed", self.answer("/switch deep gpt-b"))
        self.assertEqual(self.applied(), [])

    def test_provider_switch_needs_yes_within_two_minutes(self):
        text = self.answer("/switch deep opus")
        self.assertIn("Reply /switch yes within 2 minutes", text)
        self.assertEqual(self.applied(), [])
        [dry] = [c for c in self.tool.calls if "--dry-run" in c]
        self.assertEqual(dry[dry.index("--provider") + 1], "claude")
        text = self.answer("/switch yes")
        [apply] = self.applied()
        self.assertEqual(apply[apply.index("--provider") + 1], "claude")
        self.assertIn("--yes", apply)
        self.assertIn("✅ Deep switched for this chat (1 changed, 0 skipped):", text)
        # The confirmation is used once.
        self.assertIn("No provider switch is waiting", self.answer("/switch yes"))
        self.assertEqual(len(self.applied()), 1)

    def test_expired_or_replaced_confirmation_applies_nothing(self):
        self.answer("/switch deep opus")
        self.send("/switch yes")
        self.assertTrue(switch_command.drive(self.binding(1).worker, now=10 ** 12))
        self.assertIn("No provider switch is waiting", self.listing(1)["messages"][-1]["text"])
        self.answer("/switch deep opus")
        self.answer("/switch deep gpt-b")  # Another change cancels the waiting one.
        self.assertIn("No provider switch is waiting", self.answer("/switch yes"))
        self.assertEqual([c[3] for c in self.applied()], ["gpt-b"])

    def test_provider_shorthand_moves_this_chats_deep_after_yes(self):
        self.tool.chats = [chat(self.conversation, effort="xhigh")]
        self.assertIn("Reply /switch yes within 2 minutes", self.answer("/switch Claude"))
        self.assertEqual(self.applied(), [])
        self.answer("/switch yes")
        [apply] = self.applied()
        self.assertEqual(apply[:10], ["--layer", "deep", "--to", "opus", "--effort", "high", "--scope", self.conversation,
                                      "--provider", "claude"])
        self.assertIn("--yes", apply)
        # A valid Claude effort is kept.
        self.tool.chats = [chat(self.conversation, effort="medium")]
        self.answer("/switch claude")
        dry = [c for c in self.tool.calls if "--dry-run" in c][-1]
        self.assertEqual(dry[dry.index("--effort") + 1], "medium")

    def test_codex_shorthand_uses_the_configured_codex_default_at_high(self):
        self.tool.chats = [chat(self.conversation, provider="claude", model="opus", effort="max", fast=None)]
        self.answer("/switch CODEX")
        self.answer("/switch yes")
        [apply] = self.applied()
        self.assertEqual(apply[:10], ["--layer", "deep", "--to", "gpt-a", "--effort", "high", "--scope", self.conversation,
                                      "--provider", "codex"])

    def test_shorthand_on_the_same_provider_replies_with_status(self):
        text = self.answer("/switch codex")
        self.assertIn("Already on codex gpt-a, effort medium.", text)
        self.assertIn("All live chats", text)
        self.tool.chats = [chat(self.conversation, provider="claude", model="opus", effort="high", fast=None)]
        self.assertIn("Already on claude opus, effort high.", self.answer("/switch claude"))
        self.assertEqual(self.applied(), [])
        self.assertEqual([c for c in self.tool.calls if "--dry-run" in c], [])

    def test_fast_provider_shorthand(self):
        self.assertIn("Fast is Codex-only", self.answer("/switch fast claude"))
        self.assertIn("Fast is already on Codex: gpt-f, effort low.", self.answer("/switch fast Codex"))
        self.tool.chats = [chat(self.conversation, provider="claude", model="opus", fast=None)]
        self.assertIn("Fast preferences are Codex-only", self.answer("/switch fast codex"))
        self.assertEqual([c for c in self.tool.calls if c[:1] != ["--status"]], [])

    def test_codex_model_for_the_claude_chats_is_a_provider_switch(self):
        self.answer("/switch deep gpt-b for claude")
        self.answer("/switch yes")
        [apply] = self.applied()
        self.assertEqual(apply[apply.index("--scope") + 1], "claude")
        self.assertEqual(apply[apply.index("--provider") + 1], "codex")

    def test_a_claude_chat_switching_to_codex_asks_first(self):
        self.tool.chats = [chat(self.conversation, provider="claude", model="opus", effort="high", fast=None)]
        self.assertIn("Fast preferences are Codex-only", self.answer("/switch status"))
        self.assertIn("/switch yes", self.answer("/switch deep gpt-b"))
        self.assertEqual(self.applied(), [])

    def test_back_reverts_this_chats_latest_switch_or_all(self):
        mine = {"kind": "switch", "record": "R1", "at": "2026-10-27T00:00:00Z", "layer": "deep", "changed": [
            {"conversation": self.conversation, "name": "Chat", "before": {"provider": "codex", "model": "gpt-b", "effort": "high"},
             "after": {"provider": "codex", "model": "gpt-a", "effort": "medium"}}]}
        self.tool._history = [mine]
        self.assertIn("Switched back", self.answer("/switch back"))
        self.assertEqual(self.applied()[-1][:2], ["--revert", "R1"])
        # A switch of many chats is undone here only for this chat.
        mine["changed"].append({"conversation": OTHER, "name": "Other", "before": {}, "after": {}})
        self.answer("/switch back")
        self.assertEqual(self.applied()[-1][:8], ["--layer", "deep", "--to", "gpt-b", "--scope", self.conversation,
                                                  "--effort", "high"])
        self.answer("/switch back all")
        self.assertEqual(self.applied()[-1][:2], ["--revert", "latest"])
        # Superseded here (the chat moved again since): nothing to undo.
        mine["changed"][0]["after"]["model"] = "gpt-z"
        self.assertIn("Nothing to switch back in this chat", self.answer("/switch back"))
        self.tool._history = []
        self.assertIn("Nothing to switch back: nothing to revert", self.answer("/switch back all"))

    def test_an_unconfigured_host_says_so_and_changes_nothing(self):
        self.binding(1).worker.switcher = Switcher(tool="", records="")
        self.assertIn("not configured on this host", self.answer("/switch deep gpt-b"))

    def test_plan_rows_keep_long_names_and_notes(self):
        _, rows = switch_command.plan_lines("plan: deep -> x for 2 conversation(s)\n"
                                            "  %s codex:a/b -> codex:x/b\n  short   codex:a/b -> codex:x/-  [note]\n" % ("n" * 40))
        self.assertEqual(rows, ["n" * 40 + ": codex:a/b \u2192 codex:x/b", "short: codex:a/b \u2192 codex:x/-  [note]"])

    def test_help(self):
        self.assertEqual(self.answer("/switch").split(switch_command.FOOTER)[0], switch_command.HELP)
        self.assertIn("/switch back", self.answer("/switch help"))

    def test_v1_local_senders_are_refused(self):
        body = dict(inputKind="v1_local", publicThreadId="thread-1", publicMessageId="local-1", chatId="group-1",
                    accountId="account", role="user", connector="orkestr-v1", source="cli", text="/switch deep gpt-b",
                    externalId="local-1", origin={"role": "agent", "label": "KDP", "senderRef": "thread-kdp"})
        self.assertIn("Only the verified WhatsApp owner", self.answer("", body=body))
        self.assertEqual(self.tool.calls, [])

    def test_an_interrupted_command_is_never_re_run(self):
        self.send("/switch deep gpt-b")
        ledger = self.binding(1).ledger
        [data] = switch_command.pending(ledger)
        switch_command.mark(ledger, data, "started", pid=-1)
        switch_command.drive(self.binding(1).worker)
        self.assertIn("restarted while this /switch was running", self.listing(1)["messages"][-1]["text"])
        self.assertEqual(self.tool.calls, [])


class WorkerPassTests(unittest.TestCase):
    def test_a_worker_pass_answers_the_command_and_sends_nothing_to_rust(self):
        from v2.compat.v1_runtime.ledger import Ledger
        from v2.compat.v1_runtime.worker import Worker
        from test_worker import Peer
        with tempfile.TemporaryDirectory() as root:
            ledger = Ledger(Path(root) / "ledger.sqlite3", {"test_scope": "one"})
            ledger.enqueue({"publicMessageId": "p1", "text": "/switch status"}, {"role": "owner", "id": "o", "label": "Owner"},
                           {"kind": "switch", "text": "/switch status", "conversation": "c1"})
            peer = Peer()
            worker = Worker(peer, ledger)
            worker.switcher = FakeSwitcher([chat("c1")])
            worker.run_once(Signal())
            [user, reply] = ledger.messages()
            self.assertIn("Deep: codex gpt-a", reply["text"])
            self.assertEqual([m for m in peer.mutations if m[0] == "/messages"], [])


class MemberTests(Harness):
    def setUp(self):
        super().setUp()
        self.write(with_participants(1))
        self.registry.reload()
        self.tool = FakeSwitcher([])
        self.binding(1).worker.switcher = self.tool

    def test_a_member_is_refused_and_nothing_reaches_the_model_or_the_tool(self):
        principal = dict(connector="whatsapp", accountId="account", chatId="group-1", threadId="thread-1",
                         senderId=PHONE, participantId=PHONE, fromMe=False)
        body = self.body(1, text=HEADER + "/switch deep gpt-b all", publicMessageId="m-1", senderParticipantId=PHONE,
                         senderTrustLevel="trusted", senderEffectiveRole="trusted", originOwner=True,
                         controlAllowed=True, parseCommands=True, externalPrincipal=principal, **{"from": PHONE})
        self.assertEqual(self.post(1, body=body)[0], 202)
        self.assertIsNone(self.binding(1).ledger.next_input())
        switch_command.drive(self.binding(1).worker)
        self.assertIn("Only the verified WhatsApp owner", self.listing(1)["messages"][-1]["text"])
        self.assertEqual(self.tool.calls, [])


class ParseAndToolTests(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(parse("/switch deep gpt-b xhigh all from gpt-a"),
                         {"op": "set", "layer": "deep", "model": "gpt-b", "effort": "xhigh", "scope": "all", "from": "gpt-a"})
        self.assertEqual(parse("/switch back all"), {"op": "back", "all": True})
        self.assertEqual(parse("/switch STATUS"), {"op": "status"})
        self.assertEqual(parse("/switch deep gpt-b for claude")["scope"], "claude")
        for text in ("/switch deep all", "/switch deep gpt-b all all", "/switch deep gpt-b from", "/switch yes please"):
            with self.assertRaises(Invalid):
                parse(text)

    def test_the_real_runner_refuses_a_tool_that_is_not_root_owned(self):
        with tempfile.TemporaryDirectory() as root:
            tool = Path(root) / "orkestr-model-switch"
            tool.write_text("#!/bin/sh\necho hacked\n")
            tool.chmod(0o755)
            switcher = Switcher(tool=str(tool), records=root)
            if os.geteuid() != 0:
                self.assertFalse(switcher.trusted())
                self.assertEqual(switcher.call(["--status"], "status")[0], 127)
            self.assertEqual(Switcher(tool=root + "/missing").call(["--status"], "status")[0], 127)

    def test_history_reads_records_newest_first(self):
        with tempfile.TemporaryDirectory() as root:
            for name, at in (("A", "2026-10-26T00:00:00Z"), ("B", "2026-10-27T00:00:00Z")):
                (Path(root) / (name + ".json")).write_text(json.dumps({"kind": "switch", "at": at}))
            (Path(root) / "broken.json").write_text("{")
            self.assertEqual([r["record"] for r in Switcher(records=root).history()], ["B", "A"])


if __name__ == "__main__":
    unittest.main()
