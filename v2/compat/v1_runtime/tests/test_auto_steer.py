"""Auto-steer: an owner answer to a running Deep turn goes into that turn exactly once."""
import contextlib
import copy
import io
import time
import unittest
import uuid

from v2.compat.v1_runtime import auto_steer
from v2.compat.v1_runtime.auto_steer import decide, default_mode
from v2.compat.v1_runtime.config import binding as validate_binding
from v2.compat.v1_runtime.intake_fast import eligible
from v2.compat.v1_runtime.questions import QUESTION_PREFIX
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests.intake_fixture import identity

RUN = identity(9000)


def head(**extra):
    value = dict(remote_id="head", phase="running", chat_id="chat", account_id="account", public_thread_id="thread",
                 author=dict(role="owner", id="o", label="Owner"), intake=dict(message_id="m", event_id="e", sequence=1),
                 window=dict(window_id="w"), matched_runs=[RUN], questions_asked=[dict(run_id=RUN, at=100.0)])
    value.update(extra)
    return value


def row(**extra):
    value = dict(remote_id="answer", phase="queued", queued_at=200.0, text="Use the first name.", chat_id="chat",
                 account_id="account", public_thread_id="thread", author=dict(role="owner", id="o", label="Owner"),
                 keys=dict(message="k"))
    value.update(extra)
    return value


def deep(**extra):
    value = dict(run_id=RUN, phase="running", revision=7, control_revision=3, capabilities=dict(stop=True, steer=True))
    value.update(extra)
    return value


class DecisionTests(unittest.TestCase):
    def test_owner_answer_after_an_open_question_is_steered(self):
        self.assertEqual(decide("question", head(), row(), deep()), (True, "steerable"))
        self.assertEqual(decide("running", head(questions_asked=[]), row(), deep()), (True, "steerable"))

    def test_question_mode_needs_a_question_of_this_run_asked_before_the_message(self):
        self.assertEqual(decide("question", head(questions_asked=[]), row(), deep())[1], "no_open_question")
        late = head(questions_asked=[dict(run_id=RUN, at=300.0)])
        self.assertEqual(decide("question", late, row(), deep())[1], "no_open_question")
        other = head(questions_asked=[dict(run_id=identity(1), at=100.0)])
        self.assertEqual(decide("question", other, row(), deep())[1], "no_open_question")

    def test_only_owner_chat_input_is_ever_steered(self):
        for author in (dict(role="member", id="m", label="M"), dict(role="v1_agent", id="a", label="A"),
                       dict(role="v1_owner", id="a", label="A"), None):
            self.assertEqual(decide("running", head(), row(author=author), deep())[1], "not_owner")
        for marker in (dict(origin="timer"), dict(digest={"id": "d"}), dict(intake={"message_id": "x"}),
                       dict(burst=["b"]), dict(continued={"at": 1}), dict(requeued={"at": 1}),
                       dict(steer_fallback={"reason": "r"}), dict(phase="running")):
            self.assertEqual(decide("running", head(), row(**marker), deep())[1], "not_plain_queued_input", marker)
        self.assertEqual(decide("running", head(), row(attachments=[{"upload_id": "u"}]), deep())[1], "attachments")
        self.assertEqual(decide("running", head(), row(text="x" * 17000), deep())[1], "too_long")
        self.assertEqual(decide("running", head(), row(chat_id="other"), deep())[1], "other_chat")

    def test_timer_post_or_finished_heads_are_never_targets(self):
        self.assertEqual(decide("running", head(origin="timer"), row(), deep())[1], "head_not_chat_input")
        self.assertEqual(decide("running", head(phase="completed"), row(), deep())[1], "head_not_chat_input")
        self.assertEqual(decide("running", head(deep_final_ready_at=1.0), row(), deep())[1], "head_final_ready")
        self.assertEqual(decide("running", head(matched_runs=[]), row(), deep())[1], "head_not_running")
        self.assertEqual(decide("running", head(steered=["x"] * 8), row(), deep())[1], "steer_limit")

    def test_only_a_running_steerable_own_run_is_a_target(self):
        self.assertEqual(decide("running", head(), row(), None)[1], "no_own_deep_run")
        self.assertEqual(decide("running", head(), row(), deep(run_id=identity(2)))[1], "no_own_deep_run")
        for phase in ("awaiting_acceptance", "completed", "failed", "queued"):
            self.assertEqual(decide("running", head(), row(), deep(phase=phase))[1], "run_not_running")
        self.assertEqual(decide("running", head(), row(), deep(capabilities=dict(steer=False)))[1], "run_not_steerable")
        self.assertEqual(decide("running", head(), row(), deep(control_revision=None))[1], "run_revision_unknown")

    def test_off_disables_and_defaults_follow_the_group_shape(self):
        self.assertEqual(decide("off", head(), row(), deep())[1], "disabled")
        self.assertEqual(default_mode({"participants": []}), "question")
        self.assertEqual(default_mode({"participants": [{"ids": ["1@c.us"], "label": "A", "role": "member"}]}), "off")
        self.assertEqual(default_mode({"participants": [], "auto_steer": "off"}), "off")
        self.assertEqual(default_mode({"participants": [], "auto_steer": "running"}), "running")

    def test_binding_setting_is_validated(self):
        base = dict(conversation_id=identity(1), public_thread_id="t", chat_id="c", account_id="a",
                    remote_thread_id=identity(2), allowed_principals=["p"], excluded_public_ids=[],
                    automatic_accept_roles=["fast", "deep"], outbound_role="deep", enabled=True, revoked=False,
                    progress_updates=False, attachments=False, max_outstanding_inputs=8)
        self.assertIsNone(validate_binding(dict(base), identity(3))["auto_steer"])
        self.assertEqual(validate_binding(dict(base, auto_steer="running"), identity(3))["auto_steer"], "running")
        with self.assertRaises(ValueError):
            validate_binding(dict(base, auto_steer="always"), identity(3))


class SteerPeer(fixture.IntakePeer):
    """IntakePeer plus Rust's steer, steering-status and retire routes."""

    def __init__(self):
        super().__init__()
        self.steers, self.retired, self.payload_text = {}, {}, {}
        self.on_steer = None  # Optional hook: returns a ClientError to raise, or None.
        self.lose_steer_response = False
        self.disposition = "reserved"
        self.retire_error = None
        self.steering_down = False

    def deep(self, index=0):
        return self.runs[index, "deep"]

    def request(self, method, route, body=None, allowed=(200,)):
        path, _, run_id = route.partition("?run_id=")
        if path == "/execution":
            code, value = super().request(method, route, body, allowed)
            if code == 200:
                value.update(control_revision=1, capabilities=dict(stop=True, steer=value["phase"] == "running"))
            return code, value
        if route.startswith("/payloads/") and route[10:] in self.payload_text:
            payload = route[10:]
            return 200, dict(run_id=self.payload_text[payload][0], payload_id=payload, text=self.payload_text[payload][1])
        if method == "POST" and route == "/steer":
            self.mutations.append((route, copy.deepcopy(body)))
            control = body["control"]
            key = control["request_key"]
            if key in self.steers:
                assert self.steers[key]["request"] == body, "a replay must be the frozen request"
                return 200, copy.deepcopy(self.steers[key]["receipt"])
            if self.on_steer:
                error = self.on_steer(body)
                if error:
                    raise error
            run = next(v for v in self.runs.values() if v["run_id"] == control["run_id"])
            if run["phase"] != "running" or run["role"] != "deep":
                raise ClientError("unexpected_status", 409)
            sequence = max([0] + [event["sequence"] for event in self.events]) + 1
            self.events.append(dict(sequence=sequence, owner_id=self.owner, aggregate_id=self.conversation))
            self.revision += 1
            receipt = dict(conversation_id=self.conversation, run_id=control["run_id"], request_key=key,
                           message_id=str(uuid.uuid4()), event_id=str(uuid.uuid4()), scope_sequence=sequence,
                           disposition=self.disposition)
            self.steers[key] = dict(request=copy.deepcopy(body), receipt=receipt, written_bytes=0,
                                    state="reserved" if self.disposition == "reserved" else "queued", text=body["text"])
            if self.disposition == "reserved":
                self.steers[key]["state"] = "delivery_unknown"
            if self.lose_steer_response:
                self.lose_steer_response = False
                raise ClientError("transport_outcome_unknown")
            return 200, copy.deepcopy(receipt)
        if method == "GET" and route.startswith("/steering/"):
            if self.steering_down:
                raise (self.steering_down if isinstance(self.steering_down, ClientError)
                       else ClientError("transport_failed"))
            item = self.steers.get(route[10:])
            if not item:
                return 404, dict(code="not_found")
            return 200, dict(receipt=copy.deepcopy(item["receipt"]), state=item["state"],
                             written_bytes=item["written_bytes"])
        if method == "POST" and route.startswith("/inputs/") and route.endswith("/retire"):
            self.mutations.append((route, copy.deepcopy(body)))
            if self.retire_error:
                raise self.retire_error
            message = route[8:-7]
            self.retired.setdefault(message, body)
            item = next(i for i in self.steers.values() if i["receipt"]["message_id"] == message)
            item["state"] = "retired"
            return 201, dict(message_id=message, state="retired", request_key=body["request_key"])
        return super().request(method, route, body, allowed)

    def acknowledge_all(self, state="acknowledged"):
        for item in self.steers.values():
            if item["state"] == "delivery_unknown":
                item.update(state=state, written_bytes=len(item["text"].encode()))

    def ask(self, index=0, text="Which author name should I use?"):
        """The running Deep turn asks an asynchronous question (a marked progress payload)."""
        run = self.deep(index)["run_id"]
        payload = str(uuid.uuid4())
        self.payload_text[payload] = (run, QUESTION_PREFIX + text)
        self.event(self.inputs[index], run, schema=8, observation=dict(kind="progress_ref", payload_id=payload))


class AutoSteerFlowTests(fixture.IntakeBase):
    def setUp(self):
        super().setUp()
        self.peer = SteerPeer()
        self.worker = self.new_worker()
        self.log = io.StringIO()
        self.enterContext(contextlib.redirect_stderr(self.log))

    def new_worker(self):
        worker = super().new_worker()
        worker.auto_steer = "question"
        return worker

    def run_passes(self, count=3):
        for _ in range(count):
            self.worker.run_once(fixture.Stop())

    def texts(self):
        return [body["text"] for body in self.mutations("/messages")]

    def finals(self, parent=None):
        """Finals of WhatsApp inputs (not question posts or Fast replies)."""
        inputs = {self.row(p)["remote_id"] for p in ("first", "answer", "second")
                  if self.ledger.connect().execute("SELECT 1 FROM inputs WHERE public_id=?", (p,)).fetchone()}
        return [m for m in self.ledger.messages(500) if m["role"] == "assistant" and m.get("phase") == "final_answer"
                and m["parentMessageId"] in inputs and (parent is None or m["parentMessageId"] == parent)]

    def running_head_with_question(self):
        first = self.enqueue("first")
        self.run_passes(2)
        self.assertEqual(self.peer.deep()["phase"], "running")
        self.peer.ask()
        self.run_passes(1)
        self.assertTrue(self.row("first").get("questions_asked"))
        return first

    def finish_head(self):
        # The Fast-before-final fence needs a definite Fast transport decision.
        for message in self.fast():
            if not self.ledger.acknowledge(message["id"], {"outcome": "failed",
                    "parentPublicMessageId": "v2timer-" + message["parentMessageId"]}).get("duplicate"):
                pass
        self.peer.deep()["phase"] = "awaiting_acceptance"
        self.run_passes(3)

    def test_owner_answer_is_steered_once_and_answered_by_the_running_turn(self):
        """The production case: the answer to the running turn's question must not
        stay queued and run again as its own turn after that turn ends."""
        first = self.running_head_with_question()
        self.enqueue("answer")
        self.run_passes(1)
        [steer] = self.mutations("/steer")
        self.assertEqual(steer["control"]["run_id"], self.peer.deep()["run_id"])
        self.assertIn("Request answer", steer["text"])
        self.assertEqual(self.row("answer")["phase"], "steering")
        self.assertFalse(eligible(self.worker, self.row("answer")), "independent Fast intake skips it")

        self.peer.acknowledge_all()
        self.run_passes(1)
        answer = self.row("answer")
        self.assertEqual(answer["phase"], "completed")
        self.assertEqual(answer["absorbed_into"], first["remote_id"])
        self.assertEqual(answer["steered"]["state"], "acknowledged")
        self.assertEqual(answer["steered"]["receipt"]["request_key"], "auto-steer:" + answer["remote_id"])
        self.assertEqual(self.row("first")["steered"], [answer["remote_id"]])
        self.assertIn("auto_steer_consumed", self.log.getvalue())
        self.assertNotIn("Request answer", self.log.getvalue(), "logs carry identifiers only")

        self.finish_head()
        self.run_passes(5)
        self.assertEqual(self.texts(), ["Request first"], "the steered answer never runs as its own turn")
        self.assertEqual(len(self.mutations("/steer")), 1)
        [final] = self.finals()
        self.assertEqual(final["parentMessageId"], first["remote_id"], "one final, the running turn's")
        self.assertIsNone(self.ledger.next_input())
        self.ledger.acknowledge(final["id"], {"outcome": "delivered", "outboxJobId": "job",
                                              "parentPublicMessageId": "first"})
        self.assertTrue(self.row("first")["settled"])
        self.assertTrue(self.row("answer")["settled"], "the steered input settles with the turn's final")

    def test_frozen_steer_is_never_admitted_even_after_the_head_finishes(self):
        self.running_head_with_question()
        self.enqueue("answer")
        self.run_passes(1)
        self.assertEqual(self.row("answer")["phase"], "steering")
        # The head finishes while Rust's steering status cannot be read.
        self.peer.steering_down = True
        self.finish_head()
        self.assertEqual(self.row("first")["phase"], "completed")
        self.assertEqual(self.ledger.next_input()["public_id"], "answer")
        self.worker.step(self.ledger.next_input())
        self.assertEqual(self.texts(), ["Request first"], "the serial path never admits a held steer")
        self.run_passes(2)
        self.assertEqual(self.texts(), ["Request first"], "an unreadable status keeps the hold")
        # Only after Rust proves no byte was written does it fall back, once.
        self.peer.steering_down = False
        self.run_passes(3)
        self.assertEqual(self.row("answer")["steer_fallback"]["reason"], "steer_not_written")
        self.assertEqual(self.texts(), ["Request first", "Request answer"])

    def test_restart_after_a_lost_steer_response_replays_the_same_request(self):
        self.running_head_with_question()
        self.enqueue("answer")
        self.peer.lose_steer_response = True
        self.run_passes(1)
        self.assertNotIn("receipt", self.row("answer")["steer"])
        self.worker = self.new_worker()
        self.run_passes(1)
        self.assertEqual(len(self.peer.steers), 1, "one Rust steering record")
        self.peer.acknowledge_all()
        self.run_passes(1)
        self.assertEqual(self.row("answer")["steered"]["state"], "acknowledged")
        self.finish_head()
        self.assertEqual(self.texts(), ["Request first"])

    def test_run_ending_before_the_steer_falls_back_to_the_ordinary_queue(self):
        self.running_head_with_question()
        self.enqueue("answer")
        def finished(_):
            self.peer.deep()["phase"] = "awaiting_acceptance"
            return None
        self.peer.on_steer = finished
        self.run_passes(1)
        answer = self.row("answer")
        self.assertNotIn("steer", answer)
        self.assertEqual(answer["steer_fallback"]["reason"], "steer_refused:409")
        self.peer.on_steer = None
        self.run_passes(6)
        self.assertEqual(self.texts(), ["Request first", "Request answer"], "queued exactly once, as before")
        self.assertEqual(len(self.mutations("/steer")), 1, "never steered again")

    def test_run_ending_after_delivery_without_ack_closes_visibly_without_replay(self):
        self.running_head_with_question()
        self.enqueue("answer")
        self.run_passes(1)
        for item in self.peer.steers.values():
            item["written_bytes"] = 40  # Written to the provider, acknowledgement unknown.
        self.finish_head()
        self.run_passes(3)
        answer = self.row("answer")
        self.assertEqual(answer["refused"]["reason"], "steer_delivery_unknown")
        self.assertEqual(self.texts(), ["Request first"])
        notice = self.finals(answer["remote_id"])
        self.assertEqual(len(notice), 1)
        self.assertIn("could not confirm", notice[0]["text"])

    def test_an_unexpected_error_after_admission_never_requeues(self):
        self.running_head_with_question()
        self.enqueue("answer")
        self.run_passes(1)
        self.peer.steering_down = ClientError("unexpected_status", 403)
        self.finish_head()
        self.run_passes(3)
        self.assertEqual(self.row("answer")["phase"], "steering", "held until Rust's delivery state is readable")
        self.assertEqual(self.texts(), ["Request first"])

    def test_native_rejection_falls_back_once(self):
        self.running_head_with_question()
        self.enqueue("answer")
        self.run_passes(1)
        self.peer.acknowledge_all("rejected")
        self.run_passes(1)
        self.assertEqual(self.row("answer")["steer_fallback"]["reason"], "steer_rejected")
        self.finish_head()
        self.run_passes(4)
        self.assertEqual(self.texts(), ["Request first", "Request answer"])

    def test_queued_steer_admission_is_retired_before_ordinary_fallback(self):
        self.running_head_with_question()
        self.enqueue("answer")
        self.peer.disposition = "queued_ordered"
        self.run_passes(1)
        self.assertEqual(len(self.peer.retired), 1, "Core's copy is retired, never left to run")
        self.assertEqual(self.row("answer")["steer_fallback"]["reason"], "steer_queued_queued_ordered")
        self.run_passes(2)
        self.assertEqual(self.texts(), ["Request first", "Request answer"])

    def test_unretirable_queued_steer_is_closed_with_a_notice_not_duplicated(self):
        self.running_head_with_question()
        self.enqueue("answer")
        self.peer.disposition = "queued_unsupported"
        self.peer.retire_error = ClientError("unexpected_status", 409)
        self.run_passes(3)
        self.assertEqual(self.row("answer")["refused"]["reason"], "steer_queued_unretired")
        self.assertEqual(self.texts(), ["Request first"])

    def test_no_question_means_ordinary_queue_in_question_mode(self):
        self.enqueue("first")
        self.run_passes(2)
        self.enqueue("second")
        self.run_passes(2)
        self.assertEqual(self.mutations("/steer"), [])
        self.assertEqual(self.texts(), ["Request first", "Request second"])

    def test_running_mode_steers_without_a_question(self):
        self.worker.auto_steer = "running"
        first = self.enqueue("first")
        self.run_passes(2)
        self.enqueue("second")
        self.run_passes(1)
        self.peer.acknowledge_all()
        self.run_passes(1)
        self.assertEqual(self.row("second")["absorbed_into"], first["remote_id"])
        self.assertEqual(self.texts(), ["Request first"])

    def test_off_member_and_non_steerable_runs_keep_the_queue(self):
        self.running_head_with_question()
        self.enqueue("member", role="member")
        self.run_passes(2)
        self.assertEqual(self.mutations("/steer"), [], "a member message is never steered")
        self.worker.auto_steer = "off"
        self.enqueue("later")
        self.run_passes(2)
        self.assertEqual(self.mutations("/steer"), [])


class LegacySerialTests(fixture.IntakeBase):
    """The serial (legacy Fast) policy steers the same way; the queued input waits unadmitted."""

    def setUp(self):
        super().setUp()
        self.peer = SteerPeer()
        self.worker = self.new_worker()
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def new_worker(self):
        worker = super().new_worker()
        worker.fast_reply_policy = "legacy"
        worker.auto_steer = "question"
        return worker

    def test_serial_head_question_answer_is_steered(self):
        self.enqueue("first")
        for _ in range(2):
            self.worker.run_once(fixture.Stop())
        self.peer.ask()
        self.worker.run_once(fixture.Stop())
        self.enqueue("answer")
        self.worker.run_once(fixture.Stop())
        self.peer.acknowledge_all()
        self.worker.run_once(fixture.Stop())
        self.assertEqual(self.row("answer")["steered"]["state"], "acknowledged")
        self.assertEqual([b["text"] for b in self.mutations("/messages")], ["Request first"])


if __name__ == "__main__":
    unittest.main()
