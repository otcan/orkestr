"""Actual ordinary HTTP Worker composition; only disposable synthetic provider data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
import urllib.request

import owned_execution_http as ordinary


class WorkerCase(ordinary.Case):
    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("worker_execution_peer.py"),
                        self.root / "synthetic-provider")
        (self.root / "synthetic-provider").chmod(0o700)
        config_file = self.root / "execution.json"
        config = json.loads(config_file.read_text())
        config["worker"] = {"mode": "parent-input-once-v1", "lifetime_ms": 30000}
        config_file.write_text(json.dumps(config))
        (self.workspace / "hold-deep").touch()

    def rows(self, query, arguments=()):
        # Only this Case's newly created disposable DB. Never an operator path.
        database = (self.home / "core.sqlite3").resolve(strict=True)
        assert database.parent == self.home.resolve(strict=True)
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(query, arguments)]

    def runs(self):
        return self.rows("SELECT r.id,r.state,r.message_id,r.event_id,r.scope_sequence,"
                         "r.dispatch_state,r.candidate_hash,r.reservation_hash,"
                         "b.id AS session_id,b.role,b.native_session_id,b.parent_session_id "
                         "FROM production_runs r JOIN session_bindings b ON b.id=r.session_id")

    def role_state(self, role, state):
        found = [run for run in self.runs() if run["role"] == role and run["state"] == state]
        return found[0] if len(found) == 1 else None

    def inbox(self):
        return self.rows("SELECT sequence,message_id,event_id,state,admitted_run_id "
                         "FROM reasoning_inbox ORDER BY sequence")

    def peer_gone(self):
        pids = {row["pid"] for row in self.trace() if row["kind"] == "spawn"}
        for pid in pids:
            try:
                os.kill(pid, 0)
                return False
            except ProcessLookupError:
                pass
        return not any(self.home.rglob("worker-*"))

    def worker_gone(self):
        for row in self.trace():
            if row["kind"] == "spawn" and row["role"] == "worker":
                try:
                    os.kill(row["pid"], 0)
                    return False
                except ProcessLookupError:
                    pass
        return not any(self.home.rglob("worker-*"))

    def completion(self, run_id):
        request = urllib.request.Request(self.origin + self.path + "/events", headers={
            "Origin": self.origin, "Cookie": self.cookie})
        with ordinary.opener.open(request, timeout=3) as stream:
            assert stream.status == 200
            for count, line in enumerate(stream):
                assert count < 1000 and len(line) <= 65536
                if not line.startswith(b"data: "):
                    continue
                event = json.loads(line[6:])
                payload = event.get("payload_ref_or_safe_payload", {})
                observation = payload.get("observation", {})
                if payload.get("run_id") == run_id and observation.get("kind") == "completed_proposal":
                    return event["event_id"]
        raise AssertionError("missing exact Worker completion in authenticated HTTP events")

    def accept(self, run_id, event_id, key):
        code, status, _ = self.request(self.path + "/execution")
        assert code == 200
        return self.request(self.path + "/accept", "POST", {
            "run_id": run_id, "completion_event_id": event_id,
            "expected_revision": status["revision"], "request_key": key})


def start(case, hold_worker=False, hold_started=False, lifetime_ms=30000):
    case.stop()
    case.configure()
    config_file = case.root / "execution.json"
    config = json.loads(config_file.read_text())
    config["worker"]["lifetime_ms"] = lifetime_ms
    config_file.write_text(json.dumps(config))
    if hold_worker:
        (case.workspace / "hold-worker").touch()
    if hold_started:
        (case.workspace / "hold-deep-started").touch()
    case.start(configured=True)
    code, receipt, _ = case.message()
    assert code == 202
    return receipt


def independent_completion(case):
    receipt = start(case)
    child = ordinary.wait_for(lambda: case.role_state("worker", "awaiting_acceptance"),
                              "Worker durable completion missing")
    parent = case.role_state("deep", "running")
    assert parent is not None
    runs = case.runs()
    assert len(runs) == 2
    assert child["session_id"] != parent["session_id"]
    assert child["native_session_id"] != parent["native_session_id"]
    assert child["parent_session_id"] == parent["session_id"]
    for run in runs:
        assert run["message_id"] == receipt["message_id"]
        assert run["event_id"] == receipt["event_id"]
        assert run["scope_sequence"] == receipt["sequence"]
        assert run["dispatch_state"] == "delivery_unknown"
        assert run["candidate_hash"] is None and run["reservation_hash"] is None
    assert case.inbox() == [{"sequence": receipt["sequence"], "message_id": receipt["message_id"],
                            "event_id": receipt["event_id"], "state": "consumed",
                            "admitted_run_id": parent["id"]}]
    code, status, _ = case.request(case.path + "/execution")
    assert code == 200 and status["run_id"] == parent["id"] and status["phase"] == "running"
    assert case.request(case.path + "/execution", browser=False)[0] == 401
    events = case.completion(child["id"])
    code, accepted, _ = case.accept(child["id"], events, "synthetic-worker-accept")
    assert code == 200 and accepted["outcome"] == "succeeded"
    assert case.role_state("worker", "succeeded") is not None
    (case.workspace / "release-deep").touch()
    ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "parent completion missing")
    code, accepted, _ = case.accept(parent["id"], case.completion(parent["id"]), "synthetic-parent-accept")
    assert code == 200 and accepted["outcome"] == "succeeded"
    assert len([row for row in case.trace() if row["kind"] == "turn"]) == 2
    assert len({row["native"] for row in case.trace() if row["kind"] == "turn"}) == 2
    assert all(row["message"] == receipt["message_id"] for row in case.trace() if row["kind"] == "turn")


def revoked_before_started(case):
    start(case, hold_started=True)
    ordinary.wait_for(lambda: any(row["kind"] == "turn" for row in case.trace()),
                      "parent native turn not received")
    assert case.role_state("deep", "starting") is not None
    assert not any(row["role"] == "worker" for row in case.trace())
    case.revoke_machine()
    (case.workspace / "release-deep-started").touch()
    ordinary.wait_for(case.peer_gone, "revocation did not reap parent")
    assert not any(row["role"] == "worker" for row in case.trace())
    assert len(case.runs()) == 1


def revoked_in_flight(case):
    start(case, hold_worker=True)
    ordinary.wait_for(lambda: case.role_state("worker", "running"), "Worker did not start")
    before = case.inbox()
    case.revoke_machine()
    ordinary.wait_for(case.peer_gone, "revocation did not reap both owned native children")
    assert case.inbox() == before
    assert len([row for row in case.trace() if row["kind"] == "turn"]) == 2
    assert not case.rows("SELECT kind FROM production_observations WHERE kind IN ('stopped','completed_proposal')")
    assert all(run["state"] not in ("succeeded", "cancelled") for run in case.runs())


def parent_completion_fences_child(case):
    start(case, hold_worker=True)
    ordinary.wait_for(lambda: case.role_state("worker", "running"), "Worker did not start")
    before = case.inbox()
    (case.workspace / "release-deep").touch()
    status = ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "parent truth was not persisted")
    ordinary.wait_for(case.worker_gone, "parent completion did not clean up fenced Worker")
    assert case.role_state("worker", "blocked") is not None
    assert case.inbox() == before
    assert not case.rows("SELECT kind FROM production_observations WHERE kind='stopped'")
    assert case.accept(status["run_id"], case.completion(status["run_id"]), "unresolved-child")[0] == 409


def parent_http_stop(case):
    start(case, hold_worker=True)
    ordinary.wait_for(lambda: case.role_state("worker", "running"), "Worker did not start")
    code, status, _ = case.request(case.path + "/execution")
    assert code == 200
    before = case.inbox()
    code, receipt, _ = case.request(case.path + "/stop", "POST", {
        "run_id": status["run_id"], "expected_revision": status["revision"],
        "expected_control_revision": status["control_revision"],
        "request_key": "synthetic-parent-stop"})
    assert code == 200, "ordinary HTTP parent Stop must be implemented, not skipped"
    assert receipt["run_id"] == status["run_id"]
    ordinary.wait_for(case.peer_gone, "parent Stop did not clean up both independent children")
    assert case.inbox() == before
    assert len([row for row in case.trace() if row["kind"] == "turn"]) == 2
    assert all(run["state"] not in ("running", "starting", "succeeded") for run in case.runs())


def worker_deadline_stop(case):
    start(case, hold_worker=True, lifetime_ms=3000)
    child = ordinary.wait_for(lambda: case.role_state("worker", "running"), "Worker did not start")
    parent = case.role_state("deep", "running")
    assert parent is not None
    before = case.inbox()
    code, status, _ = case.request(case.path + "/execution")
    assert code == 200 and status["run_id"] == parent["id"]
    # No browser Stop is sent here: this independently exercises the Worker's
    # exact locally issued deadline control, not the direct HTTP control path.
    assert not case.rows("SELECT run_id FROM production_cancellations WHERE run_id=?", (child["id"],))
    ordinary.wait_for(lambda: case.role_state("worker", "cancelled"),
                      "Worker deadline needs its own actual interrupted terminal proof")
    ordinary.wait_for(case.worker_gone, "stopped Worker was not reaped")
    assert case.role_state("deep", "running") is not None
    assert case.inbox() == before
    stopped = case.rows("SELECT run_id FROM production_observations WHERE kind='stopped'")
    assert stopped == [{"run_id": child["id"]}]
    interrupts = [row for row in case.trace() if row["kind"] == "interrupt"]
    assert len(interrupts) == 1 and interrupts[0]["role"] == "worker"
    assert len([row for row in case.trace() if row["kind"] == "turn"]) == 2
    (case.workspace / "release-deep").touch()
    ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "parent completion missing")
    assert case.accept(parent["id"], case.completion(parent["id"]), "after-worker-stop")[0] == 200


SCENARIOS = [independent_completion, revoked_before_started, revoked_in_flight,
             parent_completion_fences_child, parent_http_stop, worker_deadline_stop]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--case", choices=[test.__name__ for test in SCENARIOS])
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    ordinary.binary = arguments.binary.resolve(strict=True)
    report = {"binary_sha256": hashlib.sha256(ordinary.binary.read_bytes()).hexdigest(),
              "provider_kind": "synthetic-executable", "full_release_evidence": False, "cases": []}
    selected = [test for test in SCENARIOS if not arguments.case or test.__name__ == arguments.case]
    try:
        for test in selected:
            case = WorkerCase()
            item = {"name": test.__name__, "status": "failed"}
            report["cases"].append(item)
            beginning = time.monotonic()
            try:
                case.setup()
                test(case)
            finally:
                item["elapsed_ms"] = round((time.monotonic() - beginning) * 1000, 3)
                item["trace"] = case.trace()
                case.cleanup()
            item["status"] = "passed"
            print("ordinary synthetic Worker HTTP case passed:", test.__name__, flush=True)
    finally:
        if arguments.report:
            with arguments.report.open("x") as stream:
                os.chmod(arguments.report, 0o600)
                json.dump(report, stream, indent=2)
                stream.write("\n")


if __name__ == "__main__":
    main()
