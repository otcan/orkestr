"""Throttled "Update:" progress of a long Deep run (deep_updates.py); synthetic ids only."""
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import activity, config as config_module, deep_updates, outbound_text, worker as worker_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.questions import QUESTION_PREFIX
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.worker import Worker

from test_ledger_server import Harness, binding_doc
from test_worker import Peer

OWNER = {"role": "owner", "id": "owner", "label": "Owner"}
AGENT = {"role": "v1_agent", "id": "v1:thread_bridge_message:agent-a", "label": "Connected assistant",
         "labelled": True, "source": "thread_bridge_message", "group_mirror": True}
RUN = "d0000000-0000-4000-8000-000000000001"
T0 = 1_800_000_000.0
MEMBER = [{"ids": ["491700000001@c.us"], "label": "Ayse", "role": "member"}]


class FakeWorker:
    def __init__(self, ledger):
        self.ledger, self.deep_updates = ledger, True
        self.client = SimpleNamespace(conversation="conversation")
        self.payloads, self.fetched = {}, []

    def call(self, method, route, body=None, allowed=(200,)):
        payload_id = route.rsplit("/", 1)[1]
        self.fetched.append(payload_id)
        if payload_id not in self.payloads:
            raise ClientError("unexpected_status", 404)
        return dict(run_id=RUN, payload_id=payload_id, text=self.payloads[payload_id])

    def provider_identity(self, run_id=None, status=None, fast=False):
        return {"provider": "codex", "model": "synthetic-model", "layer": "deep", "runId": run_id, "identitySource": "run"}


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "ledger.sqlite3"
        self.scope = {"remote_thread_id": "remote", "public_thread_id": "thread", "chat_id": "group", "account_id": "account"}
        self.ledger = Ledger(self.path, self.scope)
        self.worker = FakeWorker(self.ledger)

    def running(self, data):
        data.update(phase="running", admitted_at=T0, matched_runs=[RUN])
        data["deep_updates"] = {"runs": {RUN: {"started_at": T0}}}
        self.ledger.save(data)
        return data

    def enqueue(self, author=OWNER, public_id="message"):
        data, _ = self.ledger.enqueue(dict(publicMessageId=public_id, publicThreadId="thread", chatId="group",
                                           accountId="account", text="Renew the portal login, then finish the texts"), author)
        return self.running(data)

    def load(self, data):
        with self.ledger.connect() as db:
            return json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?", (data["remote_id"],)).fetchone()[0])

    def tick(self, data, payload_id, minutes, text=None, worker=None):
        """One pass at T0 + `minutes` that reads `payload_id` as the run's latest."""
        worker = worker or self.worker
        if text is not None:
            worker.payloads[payload_id] = text
        status = dict(run_id=RUN, phase="running", progress=dict(payload_id=payload_id))
        deep_updates.capture(worker, data, status, {RUN}, now=T0 + minutes * 60)

    def settle(self, data, payload_id, minutes, text, worker=None):
        """A snapshot is held at first sight, then sent once it stayed the latest."""
        self.tick(data, payload_id, minutes, text, worker)
        self.tick(data, payload_id, minutes + 0.5, worker=worker)

    def updates(self):
        with self.ledger.connect() as db:
            rows = db.execute("SELECT input_id,kind,source_key,outcome,message FROM exports "
                              "WHERE source_key LIKE 'update:%' ORDER BY seq").fetchall()
        return [dict(json.loads(message), input_id=i, export_kind=k, source_key=s, outcome=o) for i, k, s, o, message in rows]

    def copies(self):
        rows = self.ledger.listing()["messages"]
        parents = {row["id"]: row for row in rows if row.get("role") == "user" and row.get("timerSourceId") == "status"}
        return parents, [row for row in rows if row.get("parentMessageId") in parents]

    def ack(self, export_id, parent, outcome="delivered"):
        body = {"outcome": outcome, "parentPublicMessageId": parent}
        if outcome == "delivered":
            body.update(outboxJobId="scoped-relay:job", connectorMessageIds=["wa-1"],
                        deliveredAt=datetime.fromtimestamp(T0, timezone.utc).isoformat().replace("+00:00", "Z"))
        return self.ledger.acknowledge(export_id, body)


class ScheduleTests(Base):
    def test_first_update_after_fifteen_minutes_then_at_most_one_every_thirty(self):
        data = self.enqueue()
        self.settle(data, "p1", 14, "Reading the portal log.")
        self.assertEqual((self.updates(), self.worker.fetched), ([], []), "not due yet: Core is not even asked")
        self.settle(data, "p1", 15, "Reading the portal log.")
        [first] = self.updates()
        self.assertEqual((first["text"], first["kind"], first["phase"], first["role"], first["source"]),
                         ("Update: Reading the portal log.", "progress", "commentary", "assistant", "rust-v2-adapter"))
        self.assertEqual((first["export_kind"], first["source_key"], first["parentMessageId"], first["outcome"]),
                         ("progress", "update:%s:%s:p1" % (data["remote_id"], RUN), data["remote_id"], None))
        self.assertEqual((first["provider"], first["model"], first["layer"], first["runId"]),
                         ("codex", "synthetic-model", "deep", RUN))
        # Newer work inside the 30 minutes waits; the latest text goes out when due.
        self.settle(data, "p2", 20, "Logged in; drafting WP1.")
        self.settle(data, "p3", 44, "Drafting WP2.")
        self.assertEqual(len(self.updates()), 1)
        self.assertNotIn("p2", self.worker.fetched)
        self.settle(data, "p4", 45.5, "WP1 and WP2 drafted; checking the budget table.")
        self.assertEqual([u["text"] for u in self.updates()],
                         ["Update: Reading the portal log.", "Update: WP1 and WP2 drafted; checking the budget table."])
        # Persisted with the input: last-sent time and digest per run.
        run = self.load(data)["deep_updates"]["runs"][RUN]
        self.assertEqual((run["sent"], run["sent_at"]), (2, T0 + 46 * 60))
        self.assertEqual(run["digest"], deep_updates.digest("Update: WP1 and WP2 drafted; checking the budget table."))

    def test_a_snapshot_still_being_written_waits_until_it_settles(self):
        data = self.enqueue()
        self.tick(data, "p1", 15, "Checking the")
        self.tick(data, "p2", 15.1, "Checking the portal")
        self.tick(data, "p2", 15.2)  # 6 s: an unfinished sentence holds 20 s
        self.assertEqual(self.updates(), [])
        self.tick(data, "p2", 15.5)
        self.assertEqual([u["text"] for u in self.updates()], ["Update: Checking the portal"])

    def test_the_latest_text_is_cut_to_about_six_hundred_characters_at_a_word(self):
        data = self.enqueue()
        long = "Update: " + " ".join("word%03d" % n for n in range(300))
        self.settle(data, "p1", 15, long)
        [update] = self.updates()
        text = update["text"]
        self.assertTrue(text.startswith("Update: word000 "), "the model's own prefix is not doubled")
        self.assertTrue(text.endswith(" …"))
        cut = text[len("Update: "):-2]
        self.assertLessEqual(len(cut), deep_updates.MAX_CHARS)
        self.assertGreater(len(cut), deep_updates.MAX_CHARS - deep_updates.WORD_SLACK_CHARS)
        self.assertRegex(cut, r"word\d{3}$")

    def test_the_same_text_is_never_sent_twice_and_silent_texts_are_skipped(self):
        data = self.enqueue()
        self.ledger.add_progress(data, "early", "Opening the portal.")  # An ordinary early note
        self.settle(data, "p0", 15, "opening   the PORTAL.")
        self.assertEqual(self.updates(), [], "the chat already read this text")
        self.settle(data, "p1", 16, "Still reading the audit log.")
        self.settle(data, "p2", 46, "Still reading the  audit log.")
        for n, text in enumerate(("NO_REPLY", "   ", QUESTION_PREFIX + "Which call should I use?", "Update:")):
            self.settle(data, "s%d" % n, 47 + n, text)
        self.assertEqual([u["text"] for u in self.updates()], ["Update: Still reading the audit log."])
        self.settle(data, "p3", 52, "Audit log read; renewing the login.")
        self.assertEqual([u["text"] for u in self.updates()][-1], "Update: Audit log read; renewing the login.")
        # A rejected payload is read once, not on every pass.
        self.assertEqual(self.worker.fetched.count("s0"), 1)

    def test_a_removed_payload_is_skipped(self):
        data = self.enqueue()
        self.tick(data, "gone", 15)
        self.settle(data, "p1", 16, "Next step.")
        self.assertEqual([u["text"] for u in self.updates()], ["Update: Next step."])

    def test_only_this_inputs_own_running_deep_run_and_only_when_switched_on(self):
        data = self.enqueue()
        self.worker.payloads["p1"] = "Working."
        later = T0 + 20 * 60
        for status, ids in ((dict(run_id="other-run", phase="running", progress=dict(payload_id="p1")), {"other-run"}),
                            (dict(run_id=RUN, phase="awaiting_acceptance", progress=dict(payload_id="p1")), {RUN}),
                            (dict(run_id=RUN, phase="running"), {RUN}),
                            (dict(run_id=RUN, phase="running", progress=dict(payload_id="p1")), set())):
            deep_updates.capture(self.worker, data, status, ids, now=later)
        self.worker.deep_updates = False
        self.settle(data, "p1", 20, "Working.")
        self.assertEqual((self.updates(), self.worker.fetched), ([], []))

    def test_never_right_after_this_inputs_own_heartbeat_line(self):
        data = self.enqueue()
        data["activity"] = {"heartbeat_at": T0 + 15 * 60}
        self.settle(data, "p1", 16, "Working on WP3.")
        self.assertEqual(self.updates(), [])
        self.settle(data, "p1", 17.5, "Working on WP3.")
        self.assertEqual(len(self.updates()), 1)


class FinalTests(Base):
    def final(self, data, text="All three WP texts are in the portal."):
        reply = {"id": "acceptance", "role": "assistant", "state": "completed", "phase": "final_answer",
                 "source": "rust-v2-pilot", "parentMessageId": data["remote_id"], "text": text}
        self.assertTrue(self.ledger.complete(data, reply))
        return reply

    def test_nothing_after_the_final_and_the_final_withdraws_an_unsent_update(self):
        data = self.enqueue()
        stale = json.loads(json.dumps(data))
        self.settle(data, "p1", 15, "Uploading WP1.")
        self.final(data)
        self.assertEqual([u["outcome"] for u in self.updates()], ["superseded"])
        self.assertEqual([m["text"] for m in self.ledger.messages() if m["role"] == "assistant"],
                         ["All three WP texts are in the portal."])
        # A pass that still holds the input as it was before the final exports nothing.
        self.settle(stale, "p2", 50, "Uploading WP2.")
        self.assertEqual(len(self.updates()), 1)
        # A late V1 report of the withdrawn update is still recorded.
        self.assertFalse(self.ack(self.updates()[0]["id"], data["public_id"])["settled"])

    def test_a_ready_final_stops_updates(self):
        data = self.enqueue()
        data["deep_final_ready_at"] = T0 + 14 * 60
        self.settle(data, "p1", 15, "Done, writing the answer.")
        self.assertEqual(self.updates(), [])

    def test_a_delivered_update_stays_delivered_after_the_final(self):
        data = self.enqueue()
        self.settle(data, "p1", 15, "Uploading WP1.")
        self.ack(self.updates()[0]["id"], data["public_id"])
        self.final(data)
        self.assertEqual([u["outcome"] for u in self.updates()], ["delivered"])

    def test_updates_do_not_use_the_three_ordinary_progress_notes(self):
        data = self.enqueue()
        self.settle(data, "p1", 15, "Uploading WP1.")
        for n in range(3):
            self.assertIsNotNone(self.ledger.add_progress(data, "n%d" % n, "Note %d." % n))
        self.assertIsNone(self.ledger.add_progress(data, "n3", "Note 3."))


class RestartTests(Base):
    def test_a_restart_keeps_the_clock_and_never_sends_an_update_twice(self):
        data = self.enqueue()
        self.settle(data, "p1", 15, "Reading the portal log.")
        # The adapter restarts: a new ledger connection, a new worker, the stored row.
        self.ledger = Ledger(self.path, self.scope)
        worker = FakeWorker(self.ledger)
        data = self.load(data)
        self.settle(data, "p2", 20, "Logged in.", worker)
        self.assertEqual(worker.fetched, [], "the last-sent time survived")
        # A replay of the same export adopts nothing new.
        line = "Update: Reading the portal log."
        self.assertIsNone(deep_updates.export(self.ledger, data, RUN, "p1", line, {}, "input", T0 + 21 * 60))
        self.settle(data, "p1", 45.5, "Reading the portal log.", worker)
        self.settle(data, "p3", 46.5, "Logged in; drafting.", worker)
        self.assertEqual([u["text"] for u in self.updates()], [line, "Update: Logged in; drafting."])

    def test_a_held_snapshot_survives_a_restart(self):
        data = self.enqueue()
        self.tick(data, "p1", 15, "Reading the portal log.")
        self.ledger = Ledger(self.path, self.scope)
        worker = FakeWorker(self.ledger)
        worker.payloads["p1"] = "Reading the portal log."
        self.tick(self.load(data), "p1", 15.5, worker=worker)
        self.assertEqual(len(self.updates()), 1)


class GroupCopyTests(Base):
    def test_a_v1_local_request_gets_a_group_copy_on_a_status_parent(self):
        data = self.enqueue(author=AGENT, public_id="bridge-1")
        self.settle(data, "p1", 15, "Portal login renewed; uploading WP1.")
        [update] = self.updates()
        self.assertEqual((update["parentMessageId"], update["export_kind"]), (data["remote_id"], "progress"))
        parents, [copy] = self.copies()
        [parent] = parents.values()
        self.assertEqual((parent["origin"], parent["source"], parent["text"], parent["chatId"], parent["accountId"]),
                         ("timer", "orkestr-v2-timer", "Update", "group", "account"))
        self.assertEqual((copy["text"], copy["phase"], copy["role"], copy["provider"], copy["layer"], copy["runId"]),
                         ("Update: Portal login renewed; uploading WP1.", "final_answer", "assistant", "codex", "deep", RUN))
        self.assertNotIn("kind", copy)
        # V1 keeps the original with its requester and the relay sends the copy.
        self.ack(update["id"], "bridge-1", outcome="suppressed")
        self.assertTrue(self.ack(copy["id"], parent["publicMessageId"])["settled"])
        self.assertEqual(self.copies(), ({}, []))

    def test_the_final_withdraws_an_unsent_group_copy(self):
        data = self.enqueue(author=AGENT, public_id="bridge-1")
        self.settle(data, "p1", 15, "Uploading WP1.")
        reply = {"id": "acceptance", "role": "assistant", "state": "completed", "phase": "final_answer",
                 "source": "rust-v2-pilot", "parentMessageId": data["remote_id"], "text": "Done."}
        self.assertTrue(self.ledger.complete(data, reply))
        self.assertEqual(self.copies(), ({}, []), "V1 no longer lists the update copy")
        self.assertEqual([u["outcome"] for u in self.updates()], ["superseded"])
        with self.ledger.connect() as db:
            copy_id = deep_updates.copy_ids(self.updates()[0]["id"])[0]
            settled = json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?", (copy_id,)).fetchone()[0])
        self.assertEqual(settled["settled"]["outcome"], "superseded")

    def test_a_private_v1_local_request_gets_no_update(self):
        data = self.enqueue(author=dict(AGENT, group_mirror=False), public_id="bridge-1")
        self.settle(data, "p1", 15, "Uploading WP1.")
        self.assertEqual((self.updates(), self.worker.fetched), ([], []))

    def test_a_timer_run_gets_a_group_copy(self):
        data, _ = self.ledger.enqueue_timer(dict(message_id="timer-message", event_id="timer-event", sequence=5,
                                                 request_key="timer:key", namespace="ns", claim_id="claim",
                                                 source_timer_id="timer-1", label="Weekly report", due_ms=1))
        data = self.running(data)
        self.settle(data, "p1", 15, "Collected 12 of 20 sources.")
        [update] = self.updates()
        self.assertEqual(update["parentMessageId"], data["remote_id"])
        _, [copy] = self.copies()
        self.assertEqual(copy["text"], "Update: Collected 12 of 20 sources.")


class HeartbeatTests(Base):
    def test_a_heartbeat_waits_while_an_update_is_on_its_way(self):
        data = self.enqueue()
        self.settle(data, "p1", 15, "Uploading WP1.")
        worker = SimpleNamespace(ledger=self.ledger, client=SimpleNamespace(conversation="conversation"), deep_heartbeat=True)
        statuses = {"deep": {"run_id": RUN, "phase": "running"}}
        data = self.load(data)
        activity.observe(worker, data, statuses, now=T0 + 16 * 60)
        with self.ledger.connect() as db:
            self.assertTrue(deep_updates.pending(db, data["remote_id"]))
            lines = db.execute("SELECT count(*) FROM exports WHERE source_key LIKE 'final:%'").fetchone()[0]
        self.assertEqual(lines, 0, "no status line racing the update")
        with self.ledger.connect() as db:
            db.execute("UPDATE exports SET outcome='suppressed' WHERE source_key LIKE 'update:%'")
        activity.observe(worker, data, statuses, now=T0 + 16 * 60 + 1)
        with self.ledger.connect() as db:
            self.assertFalse(deep_updates.pending(db, data["remote_id"]))
            lines = db.execute("SELECT count(*) FROM exports WHERE source_key LIKE 'final:%'").fetchone()[0]
        self.assertEqual(lines, 1)


class RunClockTests(unittest.TestCase):
    def test_core_event_times_are_parsed(self):
        at = datetime(2027, 1, 15, 8, 0, tzinfo=timezone.utc).timestamp()
        self.assertEqual(deep_updates.event_time("2027-01-15T08:00:00Z"), at)
        self.assertEqual(deep_updates.event_time("2027-01-15T09:00:00+01:00"), at)
        self.assertAlmostEqual(deep_updates.event_time("2027-01-15T08:00:00.250000001Z"), at + 0.25, places=6)
        for bad in (None, "", "2027-01-15 08:00:00", "yesterday", "2027-13-15T08:00:00Z"):
            self.assertIsNone(deep_updates.event_time(bad))

    def test_a_run_is_timed_from_its_first_core_event_or_the_admission(self):
        old, new, quiet = "old-run", "new-run", "quiet-run"
        data = {"remote_id": "input", "admitted_at": T0, "matched_runs": [old]}
        started = datetime.fromtimestamp(T0 + 120, timezone.utc).isoformat().replace("+00:00", "Z")
        events = [{"occurred_at": started, "payload_ref_or_safe_payload": {"kind": "provider_observed", "run_id": new}},
                  {"occurred_at": "2999-01-01T00:00:00Z", "payload_ref_or_safe_payload": {"run_id": new}}]
        deep_updates.note_runs(data, events, {old, new, quiet}, now=T0 + 600)
        runs = data["deep_updates"]["runs"]
        self.assertEqual(runs[old]["started_at"], T0, "matched before this adapter: admission bounds its start")
        self.assertEqual(runs[new]["started_at"], T0 + 120)
        self.assertEqual(runs[quiet]["started_at"], T0 + 600)
        # Known runs are never re-timed.
        deep_updates.note_runs(data, [], {old, new, quiet}, now=T0 + 900)
        self.assertEqual(runs[new]["started_at"], T0 + 120)
        empty = {"remote_id": "input"}
        deep_updates.note_runs(empty, [], set())
        self.assertNotIn("deep_updates", empty)


class SwitchTests(unittest.TestCase):
    def doc(self, **changes):
        return config_module.binding(binding_doc(1, **changes), "owner")

    def test_on_for_an_owner_only_binding_off_with_participants_unless_set(self):
        self.assertTrue(deep_updates.enabled(self.doc()))
        self.assertFalse(deep_updates.enabled(self.doc(participants=MEMBER)))
        self.assertTrue(deep_updates.enabled(self.doc(participants=MEMBER, deep_updates=True)))
        self.assertFalse(deep_updates.enabled(self.doc(deep_updates=False)))
        for bad in ("yes", 1, 0, [], {}):
            with self.assertRaises(ValueError) as caught:
                self.doc(deep_updates=bad)
            self.assertEqual(str(caught.exception), "config_deep_updates")


class RegistryTests(Harness):
    def health(self, n=1):
        return self.request("GET", "/threads/%s/health" % self.remote(n))[1]

    def test_the_binding_setting_reaches_the_worker_and_health(self):
        self.assertIs(self.health()["deepUpdates"], True)
        self.write(binding_doc(1, participants=MEMBER))
        self.registry.reload()
        self.assertIs(self.health()["deepUpdates"], False)
        self.write(binding_doc(1, participants=MEMBER, deep_updates=True))
        self.registry.reload()
        self.assertIs(self.binding(1).worker.deep_updates, True)
        self.assertIs(self.health()["deepUpdates"], True)


class WorkerPassTests(unittest.TestCase):
    def test_a_worker_pass_exports_updates_of_its_own_running_run_then_the_final(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        ledger = Ledger(Path(temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        data, _ = ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                      accountId="account", text="request"), OWNER)
        peer, phase = Peer(), ["running:p1"]
        original = peer.request

        def request(method, route, **kwargs):
            if route.split("?", 1)[0] == "/execution" and phase[0].startswith("running"):
                return 200, dict(run_id="deep-run", revision=1, phase="running",
                                 progress=dict(payload_id=phase[0].split(":")[1]))
            if route in ("/payloads/p1", "/payloads/p2"):
                payload = route.rsplit("/", 1)[1]
                return 200, dict(run_id="deep-run", payload_id=payload, text="working on " + payload + ".")
            return original(method, route, **kwargs)
        peer.request = request
        worker = Worker(peer, ledger, legacy_companions=True)
        worker.deep_updates = True
        with patch.object(deep_updates, "FIRST_AFTER_S", 0), patch.object(deep_updates, "INTERVAL_S", 0), \
                patch.object(outbound_text, "PROGRESS_SETTLE_S", 0):
            for step in ("running:p1", "running:p1", "running:p2", "running:p2", "done"):
                phase[0] = step
                worker.step(ledger.next_input() or data)
        with ledger.connect() as db:
            rows = db.execute("SELECT kind,outcome,json_extract(message,'$.text') FROM exports WHERE input_id=? "
                              "ORDER BY seq", (data["remote_id"],)).fetchall()
            stored = json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?", (data["remote_id"],)).fetchone()[0])
        self.assertEqual(stored["deep_updates"]["runs"]["deep-run"]["payload"], "p2")
        # V1 never reported the two updates here: the final withdrew them.
        self.assertEqual(rows, [("progress", "superseded", "Update: working on p1."),
                                ("progress", "superseded", "Update: working on p2."), ("final", None, "deep result")])
        self.assertEqual(stored["deep_updates"]["runs"]["deep-run"]["sent"], 2)

    def test_an_ordinary_progress_note_never_repeats_this_runs_update(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        ledger = Ledger(Path(temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        data, _ = ledger.enqueue(dict(publicMessageId="public", publicThreadId="thread", chatId="chat",
                                      accountId="account", text="request"), OWNER)
        data["deep_updates"] = {"runs": {"deep-run": {"started_at": 0, "payload": "p1", "sent": 1}}}
        ledger.save(data)
        worker = Worker(Peer(), ledger, progress_updates=True, legacy_companions=True)
        with patch.object(worker_module, "PROGRESS_INTERVAL_S", 0):
            for _ in range(2):
                worker.capture_progress(data, dict(run_id="deep-run", phase="running",
                                                   progress=dict(payload_id="p1")), {"deep-run"})
        self.assertEqual([m for m in ledger.messages() if m["role"] == "assistant"], [])
        self.assertNotIn("p1", data.get("progress_seen", []), "the three ordinary notes stay available")


if __name__ == "__main__":
    unittest.main()
