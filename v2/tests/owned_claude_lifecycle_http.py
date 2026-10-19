"""Ordinary HTTP accepted-Claude resume/restart with synthetic owned processes."""
import json
from pathlib import Path
import shutil
import sqlite3
import time
import owned_claude_http as claude
import owned_execution_http as ordinary
from owned_native_probe import process_start


class LifecycleCase(claude.ClaudeCase):
    def stop(self):
        process = self.process
        super().stop()
        if process is not None:
            assert process.returncode == 0, "owned server cleanup must finish without forced kill"

    def trace(self):
        rows = super().trace()
        # Observe the fresh namespace's actual host identity before a negative
        # protocol case can reap it; no provider-reported PID is trusted.
        for row in rows:
            if row["kind"] == "spawn":
                (self.workspace / f"host-observed-{row['number']}").touch()
        return rows

    def configure(self, mode="continuation"):
        super().configure(mode)
        shutil.copyfile(Path(__file__).with_name("owned_claude_lifecycle_peer.py"),
                        self.root / "synthetic-provider")

    def release(self, kind, number):
        (self.workspace / f"release-{kind}-{number}").touch()

    def begun(self, number):
        return next((row for row in self.trace() if row["kind"] == "turn" and row["number"] == number), None)

    def live(self, number):
        ordinary.wait_for(lambda: self.begun(number), "exact fresh native input")
        self.release("init", number)
        def progressed():
            status = self.phase("running")
            return status if status and status["progress"] is not None and status["capabilities"]["stop"] else None
        # The peer waits at the result barrier after this one progress frame.
        # Freeze fixture output before asserting replay leaves a snapshot inert.
        return ordinary.wait_for(progressed, "matching init and one actual progress must commit")

    def propose(self, number):
        self.release("result", number)
        return ordinary.wait_for(lambda: self.phase("awaiting_acceptance"), "genuine completion proposal")

    def accept(self, proposal, number):
        request = {"run_id": proposal["run_id"],
            "completion_event_id": proposal["acceptance_candidate"]["completion_event_id"],
            "expected_revision": proposal["revision"], "request_key": f"lifecycle-accept:{number}"}
        code, receipt, _ = self.request(self.path + "/accept", "POST", request)
        assert code == 200 and receipt["outcome"] == "succeeded"
        return request, receipt

    def inert_replay(self, accepted):
        before = self.request(self.path + "/execution")[1]
        before.pop("observed_at_ms")
        assert self.request(self.path + "/accept", "POST", accepted[0])[:2] == (200, accepted[1])
        after = self.request(self.path + "/execution")[1]
        after.pop("observed_at_ms")
        assert after == before

    def old_gone(self, number):
        rows = [r for r in self.trace() if r["kind"] == "spawn" and r["number"] == number]
        return bool(rows) and all(process_start(r["pid"]) != r["process_start"] for r in rows)


def configured(mode):
    case = LifecycleCase()
    case.setup()
    case.stop()
    case.configure(mode)
    case.start(configured=True)
    ordinary.wait_for(case.native_ready, "fresh setup reserves an unobserved UUID")
    return case


def continuation(mode):
    case = configured(mode)
    try:
        assert case.message()[0] == 202
        first = case.live(1)
        assert case.message(2)[0] == 202
        proposal = case.propose(1)
        assert case.rows("SELECT count(*) FROM production_runs") == [(1,)]
        assert case.rows("SELECT count(*) FROM reasoning_inbox WHERE state='consumed'") == [(1,)]
        assert len([r for r in case.trace() if r["kind"] == "spawn"]) == 1
        accepted = case.accept(proposal, 1)
        second_input = ordinary.wait_for(lambda: case.begun(2), "accepted queued fresh input resumes")
        assert case.old_gone(1), "new native cannot start before old exact host identity disappears"
        assert second_input["prior_count"] == 1 and second_input["resumed"]
        assert second_input["native"] == case.begun(1)["native"]
        assert second_input["pid"] != case.begun(1)["pid"]
        input_id = case.rows("SELECT message_id FROM production_runs ORDER BY scope_sequence")[-1][0]
        assert second_input["input_uuid"] == input_id
        requested = case.rows("SELECT requested_native_id,observed_run_id,observed_event_key FROM production_requested_native ORDER BY binding_generation")
        assert len(requested) == 2 and requested[1] == (requested[0][0], None, None)
        case.inert_replay(accepted)
        if mode == "stale-output":
            case.release("init", 2)
            ordinary.wait_for(case.peer_gone, "prior-input output quarantines resumed child")
            rows = case.rows("SELECT kind FROM production_observations WHERE run_id=(SELECT id FROM production_runs ORDER BY scope_sequence DESC LIMIT 1)")
            assert all(kind in ("started", "lost") for (kind,) in rows)
            assert case.rows("SELECT count(*) FROM production_acceptances") == [(1,)]
            assert case.request(case.path + "/execution")[1].get("acceptance_candidate") is None
            return
        second = case.live(2)
        assert second["run_id"] != first["run_id"]
        assert second["capabilities"] == {"stop": True, "steer": False}
        stop = {"run_id": second["run_id"], "expected_revision": second["revision"],
            "expected_control_revision": second["control_revision"] + 1, "request_key": "stale-resumed-stop"}
        assert case.request(case.path + "/stop", "POST", stop)[0] == 409
        assert case.rows("SELECT count(*) FROM production_cancellations") == [(0,)]
        case.inert_replay(accepted)
        receipt2 = case.accept(case.propose(2), 2)
        ordinary.wait_for(case.peer_gone, "accepted second tree must be reaped")
        case.inert_replay(accepted)
        case.inert_replay(receipt2)
        assert case.message(2)[0] == 200
        assert len([r for r in case.trace() if r["kind"] == "turn"]) == 2
        assert case.rows("SELECT count(*) FROM reasoning_inbox WHERE state='consumed'") == [(2,)]
    finally:
        case.cleanup()


def restart():
    case = configured("restart")
    try:
        assert case.message()[0] == 202
        case.live(1)
        accepted = case.accept(case.propose(1), 1)
        ordinary.wait_for(case.peer_gone, "accepted native retires before server restart")
        previous = case.rows("SELECT incarnation_id,native_session_id FROM production_runs")[0]
        case.stop()
        assert case.rows("SELECT count(*) FROM production_graceful_retirements") == [(1,)]
        case.start(configured=True)
        case.inert_replay(accepted)
        time.sleep(0.1)
        assert len([r for r in case.trace() if r["kind"] == "spawn"]) == 1
        assert case.message(2)[0] == 202
        second = case.live(2)
        current = case.rows("SELECT incarnation_id,native_session_id FROM production_runs ORDER BY scope_sequence")[-1]
        assert current[0] != previous[0] and current[1] == previous[1]
        assert case.begun(2)["prior_count"] == 1 and case.begun(2)["resumed"]
        case.inert_replay(accepted)
        case.accept(case.propose(2), 2)
        ordinary.wait_for(case.peer_gone, "restarted accepted child is reaped")
        assert second["capabilities"] == {"stop": True, "steer": False}
    finally:
        case.cleanup()


def unknown_shutdown():
    case = configured("shutdown")
    try:
        assert case.message()[0] == 202
        first = case.live(1)
        assert case.message(2)[0] == 202
        case.stop()
        assert case.peer_gone()
        assert case.rows("SELECT state FROM production_runs") == [("cancel_requested",)]
        assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'") == [(0,)]
        held = case.rows("SELECT message_id,reason FROM production_held_inputs")
        assert len(held) == 1
        case.start()
        code, page, _ = case.request(case.path + "/held-inputs")
        assert code == 503  # Unconfigured restart cannot fabricate a live supervisor.
        assert case.request(case.path + "/execution")[1]["run_id"] == first["run_id"]
        case.stop()
        # Ordinary configured restart must refuse unresolved native truth before
        # another process/input; local reaping cannot manufacture Stopped.
        import subprocess
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "ORKESTR_V2_HOME": str(case.home),
            "ORKESTR_V2_BIND": f"127.0.0.1:{case.port}", "ORKESTR_V2_ORIGIN": case.origin,
            "ORKESTR_V2_EXECUTION_CONFIG": str(case.root / "execution.json")}
        refused = subprocess.run([str(ordinary.binary)], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=6)
        assert refused.returncode != 0
        assert len([r for r in case.trace() if r["kind"] == "turn"]) == 1
        assert case.rows("SELECT message_id,reason FROM production_held_inputs") == held
    finally:
        case.cleanup()


if __name__ == "__main__":
    for name, action in [("continuation", lambda: continuation("continuation")),
                         ("restart", restart),
                         ("stale-output", lambda: continuation("stale-output")),
                         ("unknown-shutdown", unknown_shutdown)]:
        action()
        print("ordinary synthetic Claude lifecycle case passed:", name)
