"""Split owner messages (a WhatsApp burst) get one Deep turn and a Fast reply each.

an owner chat on 2026-10-31: "Say :", "Field      notes." and
":)" arrived about 0.5 s apart while Deep was idle. Fast answered each (wanted),
but Deep answered "Say :" alone and a second Deep turn did the real work.
Core now holds a fresh owner message's Deep turn until its burst is quiet and
gives the whole burst one grouped Deep turn (store-sqlite deep_groups.rs);
the peer below plays that part. The adapter must admit every part on its own
(Fast per message, author verified per message), fold the group into one
final, and steer a part that arrives once the turn already runs.
"""
import contextlib
import hashlib
import io
import json
import time

from v2.compat.v1_runtime import auto_steer
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests.test_auto_steer import SteerPeer

PA_BURST = ("Say :", "Field      notes.", ":)")
QUIET_S = 2.5


class CoreBurstPeer(SteerPeer):
    """Core with its Deep burst rule: joining the window starts Fast at once
    but holds Deep; `quiet()` is the quiet window passing, after which one
    Deep run takes the head and every owner part of its burst that joined."""

    def __init__(self):
        super().__init__()
        self.features = frozenset({"message_author"})
        self.hold_deep = True
        self.now = 1000.0  # Core's clock for arrivals (seconds).
        self.arrival, self.authors = {}, {}
        self.deep_inputs = []  # The text each Deep run received.

    def request(self, method, route, body=None, allowed=(200,)):
        if method == "POST" and route == "/messages":
            known = any(intake["key"] == body["client_message_id"] for intake in self.inputs)
            code, value = super().request(method, route, body, allowed)
            if not known:
                self.arrival[value["message_id"]] = self.now
                self.authors[value["message_id"]] = body.get("author")
            return code, value
        return super().request(method, route, body, allowed)

    def start(self, role):
        if role == "deep" and self.hold_deep:
            return
        before = set(self.runs)
        super().start(role)
        for key in set(self.runs) - before:
            if key[1] == "deep":
                self.deep_inputs.append(self.inputs[key[0]]["text"])

    def quiet(self):
        """The burst is quiet: one Deep run for the next joined input and the
        owner parts of its burst (each within QUIET_S of the previous one)."""
        if any(run["role"] == "deep" and run["phase"] not in ("completed", "failed")
               for run in self.runs.values()):
            return None
        pending = [index for index, intake in enumerate(self.inputs)
                   if intake.get("window") and (index, "deep") not in self.runs]
        if not pending:
            return None
        head = pending[0]
        members = [head]
        for index in pending[1:]:
            intake, previous = self.inputs[index], self.inputs[members[-1]]
            if (index != members[-1] + 1 or self.authors.get(intake["message_id"]) != "owner" or
                    self.authors.get(self.inputs[head]["message_id"]) != "owner" or
                    self.arrival[intake["message_id"]] - self.arrival[previous["message_id"]] > QUIET_S):
                break
            members.append(index)
        run_id = fixture.identity(5000 + head)
        run = dict(run_id=run_id, role="deep", phase="running", progress=dict(payload_id=run_id + "-payload"),
                   acceptance_candidate=dict(run_id=run_id, completion_event_id=run_id + "-completion"))
        if len(members) > 1:
            run["grouped_inputs"] = [dict(message_id=self.inputs[i]["message_id"],
                                          event_id=self.inputs[i]["event_id"],
                                          request_key=self.inputs[i]["key"]) for i in members]
        for index in members:
            self.runs[index, "deep"] = run
        self.event(self.inputs[head], run_id)
        self.deep_inputs.append("\n\n".join(self.inputs[i]["text"] for i in members))
        return run


class BurstBase(fixture.IntakeBase):
    peer_class = CoreBurstPeer

    def setUp(self):
        super().setUp()
        self.peer = self.peer_class()
        self.worker = self.new_worker()
        self.log = io.StringIO()
        self.enterContext(contextlib.redirect_stderr(self.log))

    def send(self, public, text, role="owner", at=None):
        """WhatsApp delivers one message; Core's clock says when it arrived."""
        if at is not None:
            self.peer.now = at
        data = self.ledger.enqueue(dict(publicMessageId=public, publicThreadId="thread", chatId="chat",
                                        accountId="account", text=text),
                                   author=dict(role=role, id="synthetic-" + role, label=role))[0]
        return data

    def passes(self, count=1):
        for _ in range(count):
            self.worker.run_once(fixture.Stop())

    def fast(self):
        return [m for m in self.ledger.messages(500) if m.get("firstResponse")]

    def finals(self):
        with self.ledger.connect() as db:
            rows = db.execute("SELECT message FROM exports ORDER BY rowid").fetchall()
        return [m for (raw,) in rows if (m := json.loads(raw)).get("source") == "rust-v2-pilot"
                and m.get("phase") == "final_answer" and not m.get("firstResponse")]

    def fast_exports(self):
        with self.ledger.connect() as db:
            return [json.loads(raw) for (raw,) in db.execute(
                "SELECT message FROM exports WHERE json_extract(message,'$.firstResponse') ORDER BY rowid")]

    def ack_all_fast(self):
        """V1 delivered every exported Fast reply (the Fast-before-final fence)."""
        for message in self.fast():
            pseudo = next(m for m in self.ledger.messages(500) if m["id"] == message["parentMessageId"])
            self.ledger.acknowledge(message["id"], dict(outcome="delivered", outboxJobId="job-" + message["id"],
                parentPublicMessageId=pseudo["publicMessageId"], connectorMessageIds=["r-" + message["id"]],
                deliveredAt="2026-10-31T15:03:47Z"))

    def ack_final(self, public):
        data = self.row(public)
        with self.ledger.connect() as db:
            export = db.execute("SELECT export_id FROM exports WHERE input_id=? AND kind='final'",
                                (data["remote_id"],)).fetchone()[0]
        self.ledger.acknowledge(export, dict(outcome="delivered", outboxJobId="final-job",
            parentPublicMessageId=public, connectorMessageIds=["final-receipt"],
            deliveredAt="2026-10-31T15:04:40Z"))

    def inputs(self):
        """The WhatsApp chat inputs (not the pseudo rows Fast replies hang on)."""
        with self.ledger.connect() as db:
            rows = [json.loads(raw) for (raw,) in db.execute("SELECT data FROM inputs ORDER BY rowid")]
        return [row for row in rows if not row["public_id"].startswith("v2timer-")]

    def finish(self, run):
        self.ack_all_fast()
        run["phase"] = "awaiting_acceptance"
        self.passes(3)


class PaBurstReplayTests(BurstBase):
    def test_the_pa_burst_is_one_deep_turn_with_three_fast_replies_and_one_final(self):
        parts = [self.send("pa-1", PA_BURST[0], at=1000.03), self.send("pa-2", PA_BURST[1], at=1000.52),
                 self.send("pa-3", PA_BURST[2], at=1001.07)]
        self.passes(3)
        # Every part is its own Core message, in order, verified as the owner's.
        messages = self.mutations("/messages")
        self.assertEqual([m["text"] for m in messages], list(PA_BURST))
        self.assertEqual([m["author"] for m in messages], ["owner"] * 3)
        self.assertEqual(len({m["client_message_id"] for m in messages}), 3)
        self.assertEqual(len(self.mutations("/window")), 3)
        self.assertEqual(self.peer.deep_inputs, [], "Deep waits while the burst may still grow")
        # Fast stays per message, at once.
        self.assertEqual(sorted(m["sourceInputId"] for m in self.fast()), sorted(p["remote_id"] for p in parts))

        group = self.peer.quiet()
        self.assertEqual(self.peer.deep_inputs, ["\n\n".join(PA_BURST)], "one Deep input, all texts in order")
        self.passes(2)
        head = self.row("pa-1")
        self.assertEqual(head["deep_group"]["inputs"], [parts[1]["remote_id"], parts[2]["remote_id"]])
        for public in ("pa-2", "pa-3"):
            row = self.row(public)
            self.assertEqual((row["phase"], row["absorbed_into"]), ("completed", parts[0]["remote_id"]))
            self.assertEqual(row["deep_group_of"]["run_id"], group["run_id"])

        self.finish(group)
        [final] = self.finals()
        self.assertEqual(final["parentMessageId"], parts[0]["remote_id"])
        self.assertEqual(final["sourceInputId"], parts[2]["remote_id"], "the final quotes the burst's last part")
        self.assertEqual([b["run_id"] for b in self.mutations("/accept")].count(group["run_id"]), 1)
        self.ack_final("pa-1")
        self.passes(3)

        # Nothing lost or duplicated: three ledger rows, each settled once,
        # three Fast replies, one Deep final, no extra Core message or turn.
        rows = self.inputs()
        self.assertEqual([r["public_id"] for r in rows], ["pa-1", "pa-2", "pa-3"])
        self.assertTrue(all(r.get("settled") for r in rows))
        self.assertEqual(len(self.fast_exports()), 3, "one Fast reply per part, none twice")
        self.assertEqual(len(self.finals()), 1)
        self.assertEqual(len(self.mutations("/messages")), 3)
        self.assertEqual(len(self.peer.deep_inputs), 1)
        self.assertEqual(self.mutations("/steer"), [])
        self.assertIsNone(self.ledger.next_input())

    def test_a_message_ten_seconds_later_keeps_its_own_turn(self):
        first = self.send("first", "Find flights to Izmir.", at=1000.0)
        self.passes(2)
        run = self.peer.quiet()
        self.assertNotIn("grouped_inputs", run)
        self.passes(2)
        # Ten seconds later: a new thought, not the rest of the first.
        later = self.send("later", "Also check trains.", at=1010.0)
        later["queued_at"] = first["queued_at"] + 10
        self.ledger.save(later)
        self.passes(2)
        self.assertEqual([m["text"] for m in self.mutations("/messages")],
                         ["Find flights to Izmir.", "Also check trains."], "admitted, with its own Fast")
        self.assertEqual(len(self.fast()), 2)
        self.finish(run)
        own = self.peer.quiet()
        self.passes(2)
        self.assertIs(self.peer.runs[1, "deep"], own)
        self.assertNotEqual(own["run_id"], run["run_id"], "its own Deep turn")
        self.assertNotIn("grouped_inputs", own)
        self.assertEqual(self.peer.deep_inputs, ["Find flights to Izmir.", "Also check trains."])
        self.assertNotIn("absorbed_into", self.row("later"))

    def test_a_participant_message_inside_the_window_is_never_merged_with_the_owner(self):
        self.ledger.owner_only = True
        self.send("owner-1", "Book the room", at=1000.0)
        self.send("member", "I can join too", role="member", at=1000.4)
        self.send("owner-2", "for Friday.", at=1000.8)
        self.passes(3)
        messages = self.mutations("/messages")
        self.assertEqual([m["author"] for m in messages], ["owner", "member", "owner"],
                         "each part keeps its own verified author")
        self.assertTrue(all("Book the room" not in m["text"] or "I can join too" not in m["text"] for m in messages),
                        "no Core message mixes the owner's and the member's text")
        run = self.peer.quiet()
        self.assertNotIn("grouped_inputs", run, "the burst stops at the member")
        self.assertEqual(self.peer.deep_inputs, ["Book the room"])
        self.passes(2)
        for public in ("member", "owner-2"):
            self.assertNotIn("absorbed_into", self.row(public))
        self.assertNotIn("deep_group", self.row("owner-1"))

    def test_attachments_of_every_part_reach_core_with_their_own_message(self):
        imports = []

        def import_attachments(request):
            imports.append(request)
            return dict(import_id="import-%d" % len(imports), manifest=request["target_manifest"],
                        mapping=request["mapping"],
                        source_manifest_id=request["source"]["manifest"]["manifest_id"])
        self.peer.import_attachments = import_attachments
        self.send("text", "Here are the tickets", at=1000.0)
        content = b"jpeg-bytes"
        digest = hashlib.sha256(content).hexdigest()
        upload, _ = self.ledger.stage_upload("photo", "ticket.jpg", "image/jpeg", content, digest)
        self.peer.now = 1000.6
        self.ledger.enqueue(dict(publicMessageId="photo", publicThreadId="thread", chatId="chat",
                                 accountId="account", text="", attachments=[{"uploadId": upload, "sha256": digest}]),
                            author=dict(role="owner", id="synthetic-owner", label="owner"))
        self.passes(3)
        [request] = imports
        manifest = request["target_manifest"]["manifest_id"]
        texts = [m["text"] for m in self.mutations("/messages")]
        self.assertEqual(texts[0], "Here are the tickets")
        self.assertIn(manifest, texts[1], "the photo's own Core message carries its imported attachment")
        self.assertEqual([m["author"] for m in self.mutations("/messages")], ["owner", "owner"])
        self.peer.quiet()
        [deep_input] = self.peer.deep_inputs
        self.assertTrue(deep_input.startswith("Here are the tickets"))
        self.assertIn(manifest, deep_input, "the one Deep input carries the attachment")


class BurstSteerTests(BurstBase):
    """A part that arrives once the burst's Deep turn already runs (a long
    stream, or a Core without the burst rule) steers that turn."""

    def new_worker(self):
        worker = super().new_worker()
        worker.auto_steer = "question"
        return worker

    def running_head(self):
        self.peer.hold_deep = False  # Deep starts on the first part.
        head = self.send("part-1", "Say :", at=1000.0)
        self.passes(2)
        self.assertEqual(self.peer.runs[0, "deep"]["phase"], "running")
        return head

    def test_a_part_behind_a_running_turn_steers_it_without_an_open_question(self):
        head = self.running_head()
        self.send("part-2", "Field      notes.", at=1000.5)
        self.passes(1)
        [steer] = self.mutations("/steer")
        self.assertEqual(steer["control"]["run_id"], self.peer.runs[0, "deep"]["run_id"])
        self.assertTrue(steer["text"].startswith(auto_steer.BURST_STEER_NOTE))
        self.assertTrue(steer["text"].endswith("Field      notes."))
        self.assertIn("burst=1", self.log.getvalue())
        self.peer.acknowledge_all()
        self.passes(1)
        part = self.row("part-2")
        self.assertEqual((part["phase"], part["absorbed_into"]), ("completed", head["remote_id"]))
        self.assertTrue(part["steered"]["burst"])
        self.finish(self.peer.runs[0, "deep"])
        [final] = self.finals()
        self.assertEqual(final["parentMessageId"], head["remote_id"])
        self.assertEqual([m["text"] for m in self.mutations("/messages")], ["Say :"],
                         "the steered part never runs as its own turn")
        self.assertEqual(len(self.peer.deep_inputs), 1)

    def test_off_never_steers_and_a_late_follow_up_needs_an_open_question(self):
        self.worker.auto_steer = "off"
        self.running_head()
        self.send("part-2", "notes.", at=1000.5)
        self.passes(2)
        self.assertEqual(self.mutations("/steer"), [], "off: the part queues and Core groups it later")
        self.worker.auto_steer = "question"
        late = self.send("follow-up", "And one more thing", at=1030.0)
        late["queued_at"] = time.time() + 30
        self.ledger.save(late)
        self.passes(2)
        self.assertEqual(self.mutations("/steer"), [], "a follow-up is not a split part")

    def test_a_member_part_is_never_steered_into_the_owner_turn(self):
        self.running_head()
        self.send("member", "me too", role="member", at=1000.3)
        self.passes(2)
        self.assertEqual(self.mutations("/steer"), [])
        self.assertEqual([m["author"] for m in self.mutations("/messages")], ["owner", "member"])

    def test_burst_part_rule(self):
        owner = dict(role="owner", id="o")
        head = dict(author=owner, queued_at=100.0)
        self.assertTrue(auto_steer.burst_part(head, dict(author=owner, queued_at=102.5)))
        self.assertFalse(auto_steer.burst_part(head, dict(author=owner, queued_at=102.6)))
        self.assertTrue(auto_steer.burst_part(head, dict(author=owner, queued_at=104.0), previous_at=102.0),
                        "the chain continues from the last steered part")
        self.assertFalse(auto_steer.burst_part(head, dict(author=dict(role="member", id="o"), queued_at=100.5)))
        self.assertFalse(auto_steer.burst_part(dict(head, author=dict(role="member", id="m")),
                                               dict(author=dict(role="member", id="m"), queued_at=100.5)))
        self.assertFalse(auto_steer.burst_part(dict(head, origin="timer"), dict(author=owner, queued_at=100.5)))
        self.assertFalse(auto_steer.burst_part(head, dict(author=owner, queued_at=99.0)))
