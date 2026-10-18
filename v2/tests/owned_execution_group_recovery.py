"""Configured-set recovery through ordinary HTTP with fixed synthetic peers."""
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

from owned_execution_group import GroupCase, stop_request
from owned_execution_http import binary, wait_for


class GroupRecoveryCase(GroupCase):
    def configure_modes(self, modes):
        self.stop()
        self.configure()
        shutil.copyfile(Path(__file__).with_name("owned_execution_recovery_peer.py"),
                        self.root / "synthetic-provider")
        for workspace, mode in zip(self.workspaces, modes, strict=True):
            (workspace / "recovery-mode").write_text(mode)
        self.start(configured=True)

    def rows(self, query, args=()):
        # Read only this test's disposable database; never repair authority.
        with sqlite3.connect(f"file:{self.home / 'core.sqlite3'}?mode=ro", uri=True) as db:
            return db.execute(query, args).fetchall()

    def clean_stop(self):
        process = self.process
        assert process and process.poll() is None
        self.stop()
        assert process.returncode == 0, "all configured lifetimes must join normally"
        wait_for(self.peer_gone, "all old native identities gone before restart")

    def message_for(self, index, number):
        return self.request(self.paths[index] + "/messages", "POST", {
            "client_message_id": f"synthetic:{number}",
            "text": "synthetic ordinary HTTP input" + (f" {number}" if number > 1 else "")})

    def accept_for(self, index, status, key):
        body = {**status["acceptance_candidate"], "expected_revision": status["revision"],
                "request_key": key}
        code, receipt, _ = self.request(self.paths[index] + "/accept", "POST", body)
        assert code == 200 and receipt["outcome"] == "succeeded", (code, receipt)
        assert self.request(self.paths[index] + "/accept", "POST", body)[:2] == (200, receipt)
        return body, receipt

    def counts(self, index, processes, inputs):
        trace = self.trace_for(index)
        spawns = [row for row in trace if row["kind"] == "spawn"]
        assert len(spawns) == processes and len({row["pid"] for row in spawns}) == processes
        assert [row["input_index"] for row in trace if row["kind"] == "turn"] == inputs
        assert [row["resumed"] for row in trace if row["kind"] == "ready"] == [False] + [True] * (processes - 1)

    def refused_restart(self):
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "ORKESTR_V2_HOME": str(self.home),
                       "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}", "ORKESTR_V2_ORIGIN": self.origin,
                       "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap,
                       "ORKESTR_V2_EXECUTION_SET": str(self.root / "execution-set.json")}
        self.process = subprocess.Popen([str(binary)], env=environment, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE, text=True)
        assert self.process.wait(timeout=8) != 0
        error = self.process.stderr.read()
        assert "existing execution requires reconciliation" in error, error
        self.process.stderr.close()
        self.process = None


def accepted_set_restart(case):
    case.configure_modes(["restart", "restart"])
    prior = []
    for index in range(2):
        assert case.message_for(index, 1)[0] == 202
        status = wait_for(lambda: case.status(index, "awaiting_acceptance"), "initial proposal")
        accepted, receipt = case.accept_for(index, status, f"first-{index}")
        prior.append((status["run_id"], accepted, receipt))
        case.counts(index, 1, [1])
    old_rows = case.rows("SELECT id,conversation_id,incarnation_id,session_id,native_session_id "
                         "FROM production_runs ORDER BY conversation_id")
    assert len(old_rows) == 2
    case.clean_stop()
    began = time.monotonic()
    case.start(configured=True)
    assert time.monotonic() - began < 8, "clean set restart must not await natural lease expiry"
    for index in range(2):
        _, accepted, receipt = prior[index]
        assert case.request(case.paths[index] + "/accept", "POST", accepted)[:2] == (200, receipt)
        case.counts(index, 1, [1])
    assert case.rows("SELECT count(*) FROM production_runs") == [(2,)]
    for index in range(2):
        assert case.message_for(index, 2)[0] == 202
        status = wait_for(lambda: case.status(index, "awaiting_acceptance"), "fresh set-restart proposal")
        assert status["run_id"] != prior[index][0]
        case.counts(index, 2, [1, 2])
        before = {key: status[key] for key in ["run_id", "phase", "revision", "control_revision"]}
        _, accepted, receipt = prior[index]
        assert case.request(case.paths[index] + "/accept", "POST", accepted)[:2] == (200, receipt)
        current = case.status(index, "awaiting_acceptance")
        assert {key: current[key] for key in before} == before
        case.accept_for(index, status, f"second-{index}")
        old = next(row for row in old_rows if row[1] == case.conversations[index])
        rows = case.rows("SELECT id,incarnation_id,session_id,native_session_id FROM production_runs "
                         "WHERE conversation_id=? ORDER BY scope_sequence", (case.conversations[index],))
        assert len(rows) == 2
        assert rows[0] == (old[0], old[2], old[3], old[4])
        assert rows[1][1] != old[2] and rows[1][2:] == old[3:]
    assert len({row["pid"] for row in case.trace() if row["kind"] == "spawn"}) == 4
    case.clean_stop()


def uncertain_slot_refuses_entire_restart(case):
    # The accepted slot is intentionally first in the manifest. Even if its
    # reattachment grant is obtained, the later uncertain slot must prevent all
    # provider starts. A failed batch does not claim transactional grant rollback.
    case.configure_modes(["restart", "ack-only"])
    assert case.message_for(0, 1)[0] == 202
    accepted = wait_for(lambda: case.status(0, "awaiting_acceptance"), "first slot proposal")
    case.accept_for(0, accepted, "accepted-slot")
    assert case.message_for(1, 1)[0] == 202
    def ready():
        status = case.status(1, "running")
        return status if status and status["progress"] and status["capabilities"]["stop"] else None
    running = wait_for(ready, "second slot live Stop")
    code, old_input, _ = case.message_for(1, 2)
    assert code == 202
    code, receipt, _ = case.request(case.paths[1] + "/stop", "POST", stop_request(running, "uncertain-slot"))
    assert code == 200 and receipt["outcome"] == "requested_unknown"
    wait_for(case.probes[1].gone, "ACK-only native must be reaped")
    assert case.status(1, "cancel_requested")
    assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'") == [(0,)]
    assert case.rows("SELECT message_id FROM production_held_inputs") == [(old_input["message_id"],)]
    case.clean_stop()
    prior = case.rows("SELECT id,state,incarnation_id FROM production_runs ORDER BY id")
    case.refused_restart()
    assert case.rows("SELECT id,state,incarnation_id FROM production_runs ORDER BY id") == prior
    # Reattachment is per-slot, not an atomic batch. Only the first accepted
    # slot may have an issued setup reservation; it must remain unconfirmed.
    assert case.rows("SELECT prior_run_id,state,confirmation_digest FROM production_resume_metadata") == [
        (accepted["run_id"], "issued", None)]
    assert case.rows("SELECT message_id FROM production_held_inputs") == [(old_input["message_id"],)]
    for index in range(2):
        case.counts(index, 1, [1])
    assert case.peer_gone()


if __name__ == "__main__":
    for operation in [accepted_set_restart, uncertain_slot_refuses_entire_restart]:
        case = GroupRecoveryCase()
        try:
            case.setup()
            operation(case)
            print("group recovery case passed:", operation.__name__, flush=True)
        finally:
            case.cleanup()
