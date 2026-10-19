"""Parent proposal must clean fenced Workers before any owner acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

import worker_tasks_http as tasks
from owned_native_probe import process_start

ordinary = tasks.ordinary


class ProposalCase(tasks.TaskCase):
    def __init__(self):
        super().__init__()
        self.logs = []
        self.exits = []
        self.task_inputs = []

    def create(self, name):
        body, receipt = super().create(name)
        self.task_inputs.append(body)
        return body, receipt

    def stop(self):
        process = self.process
        copy = os.dup(process.stderr.fileno()) if process is not None else None
        try:
            super().stop()
        finally:
            if process is not None:
                self.exits.append(process.returncode)
            if copy is not None:
                try:
                    os.set_blocking(copy, False)
                    try:
                        self.logs.append(os.read(copy, 65536).decode(errors="replace"))
                    except BlockingIOError:
                        self.logs.append("")
                finally:
                    os.close(copy)

    def snapshot(self):
        path = (self.home / "core.sqlite3").resolve(strict=True)
        assert path.parent == self.home.resolve(strict=True)
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as database:
            database.execute("PRAGMA query_only=ON")
            database.execute("PRAGMA trusted_schema=OFF")
            database.execute("BEGIN")
            database.row_factory = sqlite3.Row
            queries = {
                "tasks": "SELECT id,parent_run_id,state,claim_hash FROM worker_tasks ORDER BY id",
                "runs": "SELECT id,role,state,dispatch_state FROM production_runs ORDER BY id",
                "observations": "SELECT run_id,kind,event_id FROM production_observations ORDER BY event_id",
                "acceptances": "SELECT run_id,event_id FROM production_acceptances ORDER BY run_id",
            }
            return {name: [dict(row) for row in database.execute(query)]
                    for name, query in queries.items()}


def awaiting_parent_never_owns_live_fenced_workers(case):
    # Execute the unchanged case that exposed the hosted regression first.
    tasks.parent_proposal_durably_holds_unissued_tasks(case)
    assert case.phase("awaiting_acceptance")["run_id"] == case.parent["id"]
    assert not case.task_list()["can_create"]
    before, trace = case.snapshot(), case.trace()
    assert not before["acceptances"], "cleanup cannot accept the parent"
    assert not any(row["kind"] == "stopped" for row in before["observations"])
    assert not any(row["state"] in ("queued", "claimed") or row["claim_hash"] is not None
                   for row in before["tasks"])
    assert sum(row["kind"] == "turn" for row in trace) == 5
    parent = next(row for row in trace if row["kind"] == "spawn" and row["role"] == "deep")
    assert process_start(parent["pid"]) == parent["process_start"], "owner decision must retain parent"
    # A new validly shaped owner request cannot reopen this parent's admission.
    refused = dict(case.task_inputs[0], request_key="new-task-after-parent-proposal")
    assert case.request(case.path + "/worker-tasks", "POST", refused)[0] == 503
    deadline = time.monotonic() + 0.3
    while time.monotonic() < deadline:
        assert case.phase("awaiting_acceptance")["run_id"] == case.parent["id"]
        assert case.worker_gone(), "fenced Worker or retained scratch reappeared"
        assert case.snapshot() == before, "owner decision wait changed authoritative state"
        assert case.trace() == trace, "owner decision wait dispatched native traffic"
        time.sleep(0.025)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    ordinary.binary = args.binary.resolve(strict=True)
    case = ProposalCase()
    report = {"binary_sha256": hashlib.sha256(ordinary.binary.read_bytes()).hexdigest(),
              "provider_kind": "synthetic-executable", "full_release_evidence": False,
              "name": "awaiting_parent_never_owns_live_fenced_workers", "status": "failed"}
    start = time.monotonic()
    failure = None
    try:
        case.setup()
        awaiting_parent_never_owns_live_fenced_workers(case)
    except BaseException as error:
        failure = error
        report["failure"] = repr(error)
    finally:
        report["elapsed_ms"] = round((time.monotonic() - start) * 1000, 3)
        try:
            report.update(trace=case.trace(), snapshot=case.snapshot(),
                          retained_worker_scratch=[str(path.relative_to(case.home))
                                                   for path in case.home.rglob("worker-*")])
            report["native_alive_before_cleanup"] = [
                {"pid": row["pid"], "start": row["process_start"], "role": row["role"]}
                for row in report["trace"] if row["kind"] == "spawn"
                and process_start(row["pid"]) == row["process_start"]]
        except BaseException as error:
            report["capture_failure"] = repr(error)
            failure = failure or error
        try:
            case.cleanup()
        except BaseException as error:
            report["cleanup_failure"] = repr(error)
            failure = failure or error
        report.update(server_exits=case.exits, server_diagnostics=case.logs,
                      fixture_home_removed=not case.root.exists(),
                      all_observed_native_gone=case.native_probe.gone())
        if failure is None and report["fixture_home_removed"] and report["all_observed_native_gone"]:
            report["status"] = "passed"
        with args.report.open("x") as output:
            os.chmod(args.report, 0o600)
            json.dump(report, output, indent=2)
            output.write("\n")
    if failure is not None:
        raise failure
    assert report["status"] == "passed"
    print("Worker cleanup while parent awaits owner acceptance: passed", flush=True)


if __name__ == "__main__":
    main()
