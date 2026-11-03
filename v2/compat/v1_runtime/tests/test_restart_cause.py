"""A Deep run interrupted by a server restart says so; raw codes stay in logs.

2026-11-03: a starved host crashed the server, in-flight Deep runs read
`cancelled`, and the owner saw only "(deep_run_cancelled)". The run existed
before the serving process started, so it cannot have survived that start.
Synthetic IDs, texts and peers only; nothing reaches a provider or WhatsApp.
"""
import time
import unittest

from v2.compat.v1_runtime import failure_cause, notices
from v2.compat.v1_runtime.tests.test_p0_recovery import Base, GulsahPeer

STARTED_MS = 1_793_696_164_000  # 2026-11-03 08:56:04 UTC


class RestartPeer(GulsahPeer):
    """The input's own Deep runs, then the server restarts and it reads cancelled."""

    def __init__(self):
        super().__init__()
        self.deep_phase = "running"
        self.started_at_ms = 1
        self.start_reads = 0

    def server_started_at_ms(self):
        self.start_reads += 1
        return self.started_at_ms


class RestartNoticeTests(Base):
    peer_class = RestartPeer

    def setUp(self):
        super().setUp()
        self.data["author"] = dict(role="owner", id="synthetic-owner", label="Owner")
        self.ledger.save(self.data)

    def closed(self):
        (notice,) = self.notices()
        return notice, self.ledger.input(self.data["remote_id"])

    def restart_while_running(self):
        self.passes(1)
        self.assertEqual(self.ledger.input(self.data["remote_id"])["deep_seen"]["run_id"], "deep-run")
        # The server comes back after the run was seen alive.
        self.restarted_ms = int(time.time() * 1000) + 60_000
        self.peer.started_at_ms, self.peer.deep_phase = self.restarted_ms, "cancelled"
        return self.passes(2)

    def test_a_run_alive_before_the_restart_names_the_restart(self):
        log = self.restart_while_running()
        notice, data = self.closed()
        self.assertEqual(data["refused"]["reason"], "deep_run_cancelled")
        self.assertEqual(notice["refusal"], "deep_run_cancelled", "the machine field keeps the code")
        at = time.strftime("%H:%M", time.gmtime(self.restarted_ms / 1000))
        phrase = notices.render("tr", "reason_server_restart", at=at)
        self.assertIn("(%s)" % phrase, notice["text"])
        self.assertNotIn("deep_run", notice["text"])
        self.assertIn("reason=deep_run_cancelled", log)
        self.assertIn("cause=server_restart", log)

    def test_a_run_first_seen_after_the_start_keeps_the_reason(self):
        self.peer.started_at_ms = int(time.time() * 1000) - 60_000
        log = self.passes(1)
        self.peer.deep_phase = "cancelled"
        log += self.passes(2)
        notice, _ = self.closed()
        self.assertIn("deep_run_cancelled", notice["text"])
        self.assertNotIn("cause=", log)

    def test_a_run_never_seen_alive_keeps_the_reason(self):
        # No window open time and no earlier sighting: nothing proves the run
        # predates the start, so no restart is claimed.
        self.peer.deep_phase, self.peer.started_at_ms = "cancelled", STARTED_MS
        log = self.passes(2)
        notice, _ = self.closed()
        self.assertIn("deep_run_cancelled", notice["text"])
        self.assertNotIn("cause=", log)

    def test_an_unreadable_start_keeps_the_reason(self):
        self.passes(1)

        def unavailable():
            raise OSError("connection refused")
        self.peer.server_started_at_ms, self.peer.deep_phase = unavailable, "cancelled"
        self.passes(2)
        notice, _ = self.closed()
        self.assertIn("deep_run_cancelled", notice["text"])

    def test_the_window_open_time_is_proof_too(self):
        data = dict(window={"status": {"opened_at_ms": STARTED_MS - 60_000}})
        failure_cause.note_restart(data, dict(run_id="r", phase="lost"), STARTED_MS, STARTED_MS - 60_000)
        self.assertEqual(failure_cause.cause(data, "deep_run_lost"), failure_cause.SERVER_RESTART)

    def test_a_provider_failure_or_capacity_is_never_relabelled(self):
        data = {}
        failure_cause.note_restart(data, dict(run_id="r", phase="cancelled", failure={"class": "policy"}),
                                   STARTED_MS, 1)
        self.assertIsNone(failure_cause.cause(data, "deep_run_cancelled"))
        data = {failure_cause.KEY: {"cause": failure_cause.MODEL_CAPACITY, "run_id": "r"}}
        failure_cause.note_restart(data, dict(run_id="r", phase="cancelled"), STARTED_MS, 1)
        self.assertEqual(failure_cause.cause(data, "deep_run_cancelled"), failure_cause.MODEL_CAPACITY)
        data = {}
        failure_cause.note_restart(data, dict(run_id="r", phase="completed"), STARTED_MS, 1)
        self.assertIsNone(failure_cause.cause(data, "deep_run_completed"))

    def test_every_language_has_the_wording(self):
        self.assertEqual(notices.render("en", "reason_server_restart", at="08:56"),
                         "an Orkestr server restart; back up since 08:56 UTC")
        self.assertEqual(len({notices.render(lang, "reason_server_restart", at="08:56")
                              for lang in notices.LANGUAGES}), 3)


if __name__ == "__main__":
    unittest.main()
