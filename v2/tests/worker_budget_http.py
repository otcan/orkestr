"""Actual elapsed Worker renewal; fresh synthetic native/tool processes only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import uuid

import worker_tool_http as tools
from worker_control_http import exact_status, intent
from owned_tool_probe import OwnedToolProbe

ordinary = tools.ordinary
tasks = tools.tasks


class BudgetCase(tools.ToolCase):
    host_max_ms = 60_000
    owner_max_ms = 60_000

    def __init__(self):
        super().__init__()
        self.measurements = {}

    def configure(self):
        super().configure()
        file = self.root / "execution.json"
        config = json.loads(file.read_text())
        config["execution_budget"] = {"max_run_ms": 90_000}
        config["worker"]["execution_budget"] = {"max_run_ms": self.host_max_ms}
        file.write_text(json.dumps(config))

    def input(self, name):
        request = super().input(name)
        if self.owner_max_ms is not None:
            request["execution_budget_ms"] = self.owner_max_ms
        return request

    def lease(self, run):
        rows = self.rows("SELECT r.id,r.lease_generation,r.lease_deadline_ms,r.dispatch_fence,"
                         "r.session_id,b.native_session_id,d.parent_run_id,d.expires_at_ms "
                         "FROM production_runs r JOIN session_bindings b ON b.id=r.session_id "
                         "JOIN worker_provider_delegations d ON d.admitted_run_id=r.id WHERE r.id=?", (run,))
        assert len(rows) == 1
        return rows[0]


def begin(case, source="print(6 * 7)"):
    case.mode = {"source": source, "expected_text": "42\n", "extended_fixture": True}
    tasks.begin(case)
    _, task = case.create("alpha")
    run = tasks.task_running(case, task)["run_id"]
    case.trace()  # establish exact host PID/start identities while they are live
    case.started = time.monotonic()
    case.initial = case.lease(run)
    case.initial_status = exact_status(case, run)
    assert case.initial["lease_generation"] == 1
    assert case.initial["parent_run_id"] == case.parent["id"]
    case.measurements["initial_lease"] = case.initial
    return task, run


def live_same_worker(case, task, run):
    assert case.task(task, "running"), "owner task stopped before its explicit budget"
    assert not case.worker_gone()
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    lease = case.lease(run)
    for field in ["id", "session_id", "native_session_id", "dispatch_fence", "parent_run_id"]:
        assert lease[field] == case.initial[field], "renewal changed execution identity"
    status = exact_status(case, run)
    assert status["control_revision"] == case.initial_status["control_revision"]
    return lease


def wait_elapsed(case, task, run, seconds):
    while time.monotonic() - case.started < seconds:
        live_same_worker(case, task, run)
        time.sleep(0.25)
    lease = live_same_worker(case, task, run)
    assert lease["lease_generation"] >= 2
    assert lease["lease_deadline_ms"] > case.initial["lease_deadline_ms"]
    case.measurements.update(elapsed_active_seconds=time.monotonic() - case.started,
                             renewed_lease=lease)
    return lease


def await_renewal(case, task, run):
    lease = ordinary.wait_for(
        lambda: (row if (row := live_same_worker(case, task, run))["lease_generation"] > 1 else None),
        "same Worker lease did not renew", seconds=25)
    case.measurements["renewed_lease"] = lease


def release_tool(case, marker=None):
    (case.workspace / "release-tool-request").touch()
    ordinary.wait_for(lambda: any(row["kind"] == "tool-request" for row in case.trace()),
                      "renewed Worker did not issue its native tool request")
    if marker:
        case.tool_probe = OwnedToolProbe(case.process, marker)
        ordinary.wait_for(case.tool_probe.running, "renewed Worker sandbox did not start", seconds=3)


def beyond_thirty_seconds_completes_after_current_lineage_tool(case):
    task, run = begin(case)
    lease = wait_elapsed(case, task, run, 31.5)
    release_tool(case)
    result = ordinary.wait_for(lambda: [row for row in case.trace() if row["kind"] == "tool-result"],
                               "renewed Worker did not receive the exact tool result")
    assert len(result) == 1 and result[0]["success"] is True
    delivered = ordinary.wait_for(lambda: case.rows(
        "SELECT d.parent_lease_generation,d.parent_deadline_ms,d.expires_at_ms,r.state "
        "FROM worker_tool_delegations d JOIN worker_tool_results r ON r.delegation_id=d.id "
        "WHERE d.parent_run_id=? AND r.state='delivered'", (run,)), "renewed tool delivery did not commit")
    assert len(delivered) == 1
    assert delivered[0]["parent_lease_generation"] == lease["lease_generation"]
    assert delivered[0]["expires_at_ms"] <= delivered[0]["parent_deadline_ms"]
    assert case.task(task, "running"), "tool output cannot accept its Worker task"
    (case.workspace / "release-worker").touch()
    ordinary.wait_for(lambda: case.task(task, "awaiting_acceptance"), "renewed Worker proposal missing")
    assert case.accept(run, case.completion(run), "accept-renewed-worker")[0] == 200
    assert case.task(task, "completed")
    trace = [row for row in case.trace() if row["role"] == "worker"]
    assert sum(row["kind"] == "spawn" for row in trace) == 1
    assert sum(row["kind"] == "turn" for row in trace) == 1
    case.measurements["delivered_tool"] = delivered[0]
    tasks.stop_parent(case)


def renewed_stop_reaps_tool_and_preserves_parent(case):
    marker = "synthetic-renewed-tool:" + str(uuid.uuid4())
    task, run = begin(case, "# " + marker + "\nwhile True: pass")
    wait_elapsed(case, task, run, 31.5)
    release_tool(case, marker)
    # The original control state still identifies the same owner/run after renewal.
    body = intent(case.initial_status, "stop-renewed-worker-tool")
    ordinary.wait_for(lambda: exact_status(case, run)["capabilities"]["stop"], "renewed Worker Stop unavailable")
    assert case.request(case.path + "/stop", "POST", body)[0] == 200
    ordinary.wait_for(lambda: case.task(task, "cancelled"), "renewed Worker terminal Stop missing")
    assert case.tool_probe.gone(), "physical Python reap must precede Worker cancellation"
    ordinary.wait_for(case.worker_gone, "renewed native Worker was not reaped")
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    assert not case.rows("SELECT delegation_id FROM worker_tool_results WHERE state='delivered'")
    stopped = case.rows("SELECT run_id FROM production_observations WHERE kind='stopped'")
    assert stopped == [{"run_id": run}]
    tasks.stop_parent(case)


def revoked_renewed_worker_cannot_renew_or_deliver(case):
    marker = "synthetic-renewal-revocation:" + str(uuid.uuid4())
    task, run = begin(case, "# " + marker + "\nwhile True: pass")
    await_renewal(case, task, run)
    release_tool(case, marker)
    case.revoke_machine()
    ordinary.wait_for(case.peer_gone, "revocation did not reap renewed native/tool children")
    assert case.tool_probe.gone()
    before = case.rows("SELECT * FROM production_run_leases WHERE run_id=? ORDER BY generation", (run,))
    # No active runtime remains; a bounded observation confirms no resumed renewal.
    time.sleep(0.1)
    assert before == case.rows("SELECT * FROM production_run_leases WHERE run_id=? ORDER BY generation", (run,))
    assert not case.rows("SELECT delegation_id FROM worker_tool_results WHERE state='delivered'")
    assert not case.rows("SELECT run_id FROM production_observations WHERE run_id=? AND kind IN ('stopped','completed_proposal')", (run,))
    case.measurements["final_lease_history"] = before


def host_opt_in_cannot_extend_a_legacy_owner_deadline(case):
    case.owner_max_ms = None
    task, run = begin(case)
    ordinary.wait_for(lambda: case.task(task, "cancelled"), "legacy owner deadline was extended", seconds=35)
    assert time.monotonic() - case.started < 32
    ordinary.wait_for(case.worker_gone, "legacy deadline cleanup did not finish")
    assert case.rows("SELECT generation FROM production_run_leases WHERE run_id=? AND purpose='execution'", (run,)) == [{"generation": 1}]
    assert not case.rows("SELECT run_id FROM worker_running_budgets WHERE run_id=?", (run,))
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    tasks.stop_parent(case)


def explicit_owner_hard_budget_remains_below_host_cap(case):
    case.owner_max_ms = 31_000
    task, run = begin(case)
    ordinary.wait_for(lambda: case.task(task, "cancelled"), "explicit owner hard budget was exceeded", seconds=35)
    assert time.monotonic() - case.started < 33
    ordinary.wait_for(case.worker_gone, "owner hard budget cleanup did not finish")
    rows = case.rows("SELECT anchor_ms,deadline_ms FROM worker_running_budgets WHERE run_id=?", (run,))
    assert len(rows) == 1 and rows[0]["deadline_ms"] - rows[0]["anchor_ms"] <= 31_000
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    case.measurements["durable_owner_bound"] = rows[0]
    tasks.stop_parent(case)


SCENARIOS = [beyond_thirty_seconds_completes_after_current_lineage_tool,
             renewed_stop_reaps_tool_and_preserves_parent,
             revoked_renewed_worker_cannot_renew_or_deliver,
             host_opt_in_cannot_extend_a_legacy_owner_deadline,
             explicit_owner_hard_budget_remains_below_host_cap]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--case", choices=[test.__name__ for test in SCENARIOS])
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    ordinary.binary = arguments.binary.resolve(strict=True)
    report = {"binary_sha256": hashlib.sha256(ordinary.binary.read_bytes()).hexdigest(),
              "provider_kind": "synthetic-executable", "full_release_evidence": False, "cases": []}
    try:
        for test in SCENARIOS:
            if arguments.case and test.__name__ != arguments.case:
                continue
            case = BudgetCase()
            item = {"name": test.__name__, "status": "failed"}
            report["cases"].append(item)
            started = time.monotonic()
            try:
                case.setup()
                test(case)
            finally:
                item["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
                item["measurements"] = case.measurements
                try:
                    item["trace"] = case.trace()
                finally:
                    case.cleanup()
            item["status"] = "passed"
            print("ordinary synthetic Worker budget HTTP case passed:", test.__name__, flush=True)
    finally:
        if arguments.report:
            with arguments.report.open("x") as stream:
                os.chmod(arguments.report, 0o600)
                json.dump(report, stream, indent=2)
                stream.write("\n")


if __name__ == "__main__":
    main()
