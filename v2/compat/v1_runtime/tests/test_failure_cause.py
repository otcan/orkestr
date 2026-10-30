"""A Deep run stopped by a model-capacity error says so; raw codes stay in logs.

Synthetic IDs, texts and peers only; nothing reaches a provider or WhatsApp.
"""
import json
import unittest

from v2.compat.v1_runtime import failure_cause, notices
from v2.compat.v1_runtime.tests.test_p0_recovery import Base, GulsahPeer


class CapacityPeer(GulsahPeer):
    """The input's own Deep ends with Core's closed failure class."""

    def __init__(self):
        super().__init__()
        self.deep_phase, self.failure, self.provider = "failed", "provider", "codex"

    def request(self, method, route, body=None, allowed=(200,)):
        status, value = super().request(method, route, body=body, allowed=allowed)
        if route.split("?", 1)[0] == "/execution" and isinstance(value, dict) and value.get("run_id") == "deep-run":
            value = dict(value, models=dict(provider=self.provider, resolved_model="synthetic-model"))
            if self.failure and value.get("phase") == "failed":
                value["failure"] = {"class": self.failure}
        return status, value


class CapacityNoticeTests(Base):
    peer_class = CapacityPeer

    def setUp(self):
        super().setUp()
        self.data["author"] = dict(role="owner", id="synthetic-owner", label="Owner")
        self.ledger.save(self.data)

    def closed(self):
        (notice,) = self.notices()
        return notice, self.ledger.input(self.data["remote_id"])

    def test_codex_capacity_failure_names_the_cause_not_the_code(self):
        log = self.passes(2)
        notice, data = self.closed()
        self.assertEqual(data["refused"]["reason"], "deep_run_failed:provider")
        self.assertEqual(notice["refusal"], "deep_run_failed:provider", "the machine field keeps the code")
        phrase = notices.render("tr", "reason_model_capacity")
        self.assertIn("(%s)" % phrase, notice["text"])
        self.assertNotIn("deep_run", notice["text"])
        self.assertNotIn("provider", notice["text"])
        self.assertIn("reason=deep_run_failed:provider", log)
        self.assertIn("cause=model_capacity", log)

    def test_a_later_cancel_of_the_same_run_keeps_the_cause(self):
        failed = dict(run_id="deep-run", phase="failed", failure={"class": "provider"}, models={"provider": "codex"})
        failure_cause.note(self.data, failed)
        failure_cause.note(self.data, dict(run_id="deep-run", phase="cancelled", models={"provider": "codex"}))
        self.data["retry_withheld"] = "run_started"
        self.ledger.refuse(self.data, "deep_run_cancelled")
        notice, data = self.closed()
        self.assertIn(notices.render("tr", "reason_model_capacity"), notice["text"])
        self.assertEqual(data["refused"]["reason"], "deep_run_cancelled")

    def test_another_run_ending_forgets_the_cause(self):
        failure_cause.note(self.data, dict(run_id="first", phase="failed", failure={"class": "provider"},
                                           models={"provider": "codex"}))
        failure_cause.note(self.data, dict(run_id="second", phase="cancelled"))
        self.assertIsNone(failure_cause.cause(self.data, "deep_run_cancelled"))

    def test_other_provider_classes_keep_the_reason(self):
        for provider, failure in (("claude", "provider"), ("codex", "quota"), ("codex", None)):
            with self.subTest(provider=provider, failure=failure):
                self.setUp()
                self.peer.provider, self.peer.failure = provider, failure
                log = self.passes(2)
                notice, data = self.closed()
                self.assertNotIn(notices.render("tr", "reason_model_capacity"), notice["text"])
                self.assertIn(data["refused"]["reason"], notice["text"])
                self.assertNotIn("cause=", log)

    def test_explicit_capacity_class_is_understood(self):
        self.assertTrue(failure_cause.is_capacity(dict(run_id="r", failure={"class": "capacity"})))
        self.assertFalse(failure_cause.is_capacity(dict(run_id="r", failure={"class": "provider"},
                                                        models={"provider": "claude"})))

    def test_a_timer_says_it_in_the_chat_language(self):
        for lang, text in (("en", "Daily check"), ("de", "Täglicher Check")):
            with self.subTest(lang=lang):
                self.setUp()
                self.data.update(origin="timer", timer=dict(label=text), text="x", retry_withheld="run_started")
                failure_cause.note(self.data, dict(run_id="deep-run", phase="failed", failure={"class": "provider"},
                                                   models={"provider": "codex"}))
                self.ledger.save(self.data)
                with self.ledger.connect() as db:
                    db.execute("INSERT INTO ledger_meta VALUES ('chat_language',?) ON CONFLICT(key) DO UPDATE "
                               "SET value=excluded.value", (json.dumps([lang, lang]),))
                self.ledger.refuse(self.data, "deep_run_failed:provider", alert=True)
                (notice,) = [m for m in self.ledger.messages() if m.get("kind") == "notice"]
                expected = notices.render(lang, "timer_interrupted", label=text,
                                          reason=notices.render(lang, "reason_model_capacity"))
                self.assertEqual(notice["text"], expected)

    def test_every_language_has_the_wording(self):
        self.assertEqual(notices.render("en", "reason_model_capacity"), "stopped by a model-capacity error")
        self.assertEqual(len({notices.render(lang, "reason_model_capacity") for lang in notices.LANGUAGES}), 3)


if __name__ == "__main__":
    unittest.main()
