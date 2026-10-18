"""Ordinary HTTP lifecycle against a fixed native peer, never real credentials."""
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import time

from owned_execution_http import Case, binary, wait_for


class RecoveryCase(Case):
    def configure_mode(self, mode):
        self.stop()
        self.configure()
        shutil.copyfile(Path(__file__).with_name("owned_execution_recovery_peer.py"),
                        self.root / "synthetic-provider")
        (self.workspace / "recovery-mode").write_text(mode)
        self.start(configured=True)

    def peer_gone(self):
        return super().peer_gone()

    def clean_stop(self):
        assert self.process is not None and self.process.poll() is None
        self.trace()
        self.process.send_signal(signal.SIGINT)
        assert self.process.wait(timeout=8) == 0, "controlled shutdown must finish cleanly"
        self.process.stderr.close()
        self.process = None
        wait_for(self.peer_gone, "every old native process must be gone before restart")

    def refused_restart(self):
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "ORKESTR_V2_HOME": str(self.home),
                       "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}", "ORKESTR_V2_ORIGIN": self.origin,
                       "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap,
                       "ORKESTR_V2_EXECUTION_CONFIG": str(self.root / "execution.json")}
        self.process = subprocess.Popen([str(binary)], env=environment, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE, text=True)
        assert self.process.wait(timeout=8) != 0, "uncertain execution must refuse configured restart"
        self.process.stderr.close()
        self.process = None

    def rows(self, query, args=()):
        # Synthetic fixture only. Read metadata, never write authority/clock/grants.
        with sqlite3.connect(f"file:{self.home / 'core.sqlite3'}?mode=ro", uri=True) as database:
            return database.execute(query, args).fetchall()

    def held(self):
        code, body, headers = self.request(self.path + "/held-inputs")
        assert code == 200 and headers["Cache-Control"] == "no-store"
        assert body["schema_version"] == 1 and body["conversation_id"] == self.conversation
        return body


def snapshot(case):
    code, body, _ = case.request(case.path + "/execution")
    assert code == 200
    return {key: body[key] for key in ("run_id", "phase", "revision", "control_revision")}


def accept(case, status, key):
    body = {**status["acceptance_candidate"], "expected_revision": status["revision"],
            "request_key": key}
    code, receipt, _ = case.request(case.path + "/accept", "POST", body)
    assert code == 200 and receipt["outcome"] == "succeeded"
    assert case.request(case.path + "/accept", "POST", body)[:2] == (200, receipt)
    return body, receipt


def counts(case, processes, inputs):
    trace = case.trace()
    spawns = [row for row in trace if row["kind"] == "spawn"]
    assert len(spawns) == processes and len({row["pid"] for row in spawns}) == processes
    assert [row["input_index"] for row in trace if row["kind"] == "turn"] == inputs
    assert [row["resumed"] for row in trace if row["kind"] == "ready"] == [False] + [True] * (processes - 1)


def stop_intent(case):
    assert case.message()[0] == 202
    def available():
        status = case.phase("running")
        return status if status and status["capabilities"]["stop"] and status["progress"] else None
    running = wait_for(available, "running native progress with Stop authority")
    old = case.message(2)
    assert old[0] == 202
    body = {"run_id": running["run_id"], "expected_revision": running["revision"],
            "expected_control_revision": running["control_revision"], "request_key": "recovery-stop"}
    code, receipt, _ = case.request(case.path + "/stop", "POST", body)
    assert code == 200, "one original stable-control Stop intent must succeed"
    assert receipt["outcome"] == "requested_unknown"
    return running, old[1], body, receipt


def assert_held(case, old, run):
    page = case.held()
    assert len(page["held"]) == 1 and page["next_after_sequence"] is None
    hold = page["held"][0]
    assert hold["message_id"] == old["message_id"]
    assert hold["source_event_id"] == old["event_id"]
    assert hold["scope_sequence"] == old["sequence"]
    assert hold["reason"] == "stop_boundary" and hold["boundary_run_id"] == run
    assert hold["through_scope_sequence"] >= hold["scope_sequence"]
    assert hold["boundary_event_id"]
    assert not page["eligible_input_available"]
    assert case.rows("SELECT state FROM reasoning_inbox WHERE message_id=?", (old["message_id"],)) == [("queued",)]
    assert case.rows("SELECT count(*) FROM production_runs WHERE message_id=?", (old["message_id"],)) == [(0,)]
    return hold


def stop_then_fresh_input(case):
    case.configure_mode("stop")
    running, old, stop, receipt = stop_intent(case)
    wait_for(lambda: case.phase("cancelled"), "confirmed native terminal Stop")
    wait_for(case.peer_gone, "Stop must reap old native before any replacement")
    held = assert_held(case, old, running["run_id"])
    # The sole held item must not spend a setup reservation or spawn an idle peer.
    time.sleep(0.25)
    counts(case, 1, [1])
    assert case.rows("SELECT count(*) FROM production_resume_metadata") == [(0,)]
    assert case.request(case.path + "/held-inputs?limit=0")[0] == 400
    assert case.request(case.path + "/held-inputs?limit=1&limit=2")[0] == 400
    assert case.request(case.path + "/held-inputs?provider_auth=forbidden")[0] == 400
    assert case.request(case.path + "/held-inputs", browser=False)[0] == 401
    assert case.request(case.path + "/held-inputs", extra={"Origin": "https://foreign.invalid"})[0] == 403
    assert case.message(3)[0] == 202
    successor = wait_for(lambda: case.phase("awaiting_acceptance"), "fresh post-Stop input proposal")
    assert successor["run_id"] != running["run_id"]
    counts(case, 2, [1, 3])
    assert assert_held(case, old, running["run_id"]) == held
    before = snapshot(case)
    assert case.request(case.path + "/stop", "POST", stop)[:2] == (200, receipt)
    assert snapshot(case) == before
    assert sum(row["kind"] == "interrupt" for row in case.trace()) == 1
    accept(case, successor, "after-stop-accept")
    assert case.rows("SELECT count(DISTINCT native_session_id),count(DISTINCT session_id) FROM production_runs") == [(1, 1)]
    assert case.rows("SELECT count(*) FROM production_resume_metadata WHERE state='confirmed'") == [(1,)]
    case.clean_stop()


def accepted_restart_then_fresh_input(case):
    case.configure_mode("restart")
    assert case.message()[0] == 202
    first = wait_for(lambda: case.phase("awaiting_acceptance"), "first accepted restart proposal")
    accepted, receipt = accept(case, first, "before-restart-accept")
    prior = case.rows("SELECT id,incarnation_id,session_id,native_session_id FROM production_runs")
    assert len(prior) == 1
    case.clean_stop()
    began = time.monotonic()
    case.start(configured=True)
    assert time.monotonic() - began < 8, "clean retirement must not wait for a 60-second lease"
    assert case.request(case.path + "/accept", "POST", accepted)[:2] == (200, receipt)
    counts(case, 1, [1])
    assert case.message(2)[0] == 202
    second = wait_for(lambda: case.phase("awaiting_acceptance"), "configured restart fresh-input proposal")
    assert second["run_id"] != first["run_id"]
    counts(case, 2, [1, 2])
    rows = case.rows("SELECT id,incarnation_id,session_id,native_session_id FROM production_runs ORDER BY scope_sequence")
    assert len(rows) == 2 and rows[0] == prior[0]
    assert rows[1][1] != prior[0][1] and rows[1][2:] == prior[0][2:]
    before = snapshot(case)
    assert case.request(case.path + "/accept", "POST", accepted)[:2] == (200, receipt)
    assert snapshot(case) == before
    accept(case, second, "after-restart-accept")
    case.clean_stop()


def ack_only_never_restarts(case):
    case.configure_mode("ack-only")
    running, old, _, _ = stop_intent(case)
    wait_for(case.peer_gone, "ACK-only must clean its child without inventing terminal proof")
    assert case.phase("cancel_requested")
    held = assert_held(case, old, running["run_id"])
    assert case.message(3)[0] == 202
    time.sleep(0.25)
    counts(case, 1, [1])
    assert case.held()["held"] == [held] and case.held()["eligible_input_available"]
    assert case.rows("SELECT count(*) FROM production_runs") == [(1,)]
    case.clean_stop()
    prior = case.rows("SELECT id,state,incarnation_id FROM production_runs")
    case.refused_restart()
    assert case.rows("SELECT id,state,incarnation_id FROM production_runs") == prior
    assert case.rows("SELECT count(*) FROM production_resume_metadata") == [(0,)]
    counts(case, 1, [1])


if __name__ == "__main__":
    for scenario in (stop_then_fresh_input, accepted_restart_then_fresh_input, ack_only_never_restarts):
        case = RecoveryCase()
        try:
            case.setup()
            scenario(case)
            print("ordinary recovery HTTP case passed:", scenario.__name__)
        finally:
            case.cleanup()
