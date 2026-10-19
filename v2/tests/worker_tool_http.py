"""Ordinary authenticated Worker→offline Python→same native call, synthetic only."""
import hashlib
import json
from pathlib import Path
import shutil
import uuid

import worker_tasks_http as tasks
from owned_tool_probe import OwnedToolProbe
from worker_control_http import exact_status, intent

ordinary = tasks.ordinary
worker = tasks.worker


class ToolCase(tasks.TaskCase):
    mode = None
    tool_probe = None

    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("worker_tool_peer.py"), self.root / "synthetic-provider")
        (self.root / "synthetic-provider").chmod(0o700)
        config_file = self.root / "execution.json"
        config = json.loads(config_file.read_text())
        config["worker"]["offline_python"] = True
        launcher = self.root / "synthetic-worker-launcher"
        launcher.write_text("#!/usr/bin/python3\nimport sys\n"
                            f"sys.path.insert(0, {str(ordinary.broker)!r})\nfrom server import main\n"
                            f"raise SystemExit(main({str(self.root / 'broker-private.json')!r}, offline_python=True))\n")
        launcher.chmod(0o700)
        config["worker"]["broker_launcher"] = str(launcher)
        config["worker"]["broker_launcher_sha256"] = hashlib.sha256(launcher.read_bytes()).hexdigest()
        config_file.write_text(json.dumps(config))
        assert self.mode is not None
        (self.workspace / "synthetic-tool-case.json").write_text(json.dumps(self.mode))

    def peer_gone(self):
        return super().peer_gone() and (self.tool_probe is None or self.tool_probe.gone())

    def worker_gone(self):
        return super().worker_gone() and (self.tool_probe is None or self.tool_probe.gone())


def begin(case, source, **mode):
    case.mode = {"source": source, "expected_text": "42\n", **mode}
    tasks.begin(case)
    _, task = case.create("alpha")
    status = tasks.task_running(case, task)
    case.trace()  # own native host identity before a refusal can reap it
    (case.workspace / "release-tool-request").touch()
    # Intent synchronizes unsupported refusal, and is not proof of emission.
    marker = "tool-request-intent" if mode.get("unsupported") else "tool-request"
    ordinary.wait_for(lambda: any(row["kind"] == marker for row in case.trace()),
                      f"native Worker did not record {marker}")
    return task, status["run_id"]


def successful_result_is_correlated_then_requires_owner_acceptance(case):
    sentinel = case.root / "synthetic-outside-sentinel"
    sentinel.write_text("synthetic content outside the tool filesystem")
    source = ("import os\n"
              f"assert not os.path.exists({str(sentinel)!r})\n"
              "print(6 * 7)")
    task, run = begin(case, source)
    results = ordinary.wait_for(lambda: [row for row in case.trace() if row["kind"] == "tool-result"],
                                "exact native result never arrived")
    assert len(results) == 1 and results[0]["success"] is True
    rows = ordinary.wait_for(lambda: case.rows(
        "SELECT d.id,d.parent_run_id,d.source_digest,d.state AS execution_state,"
        "r.request_id,r.call_id,r.state,r.written_bytes,r.success "
        "FROM worker_tool_delegations d JOIN worker_tool_results r ON r.delegation_id=d.id WHERE r.state='delivered'"),
        "result transport delivery did not commit")
    assert len(rows) == 1 and rows[0]["parent_run_id"] == run
    assert rows[0]["source_digest"] == hashlib.sha256(source.encode()).hexdigest()
    assert rows[0]["execution_state"] == "completed" and rows[0]["success"] == 1
    assert rows[0]["written_bytes"] > 0 and rows[0]["request_id"] == results[0]["request_id"]
    assert case.task(task, "running"), "tool delivery must not accept the Worker"
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    (case.workspace / "release-worker").touch()
    ordinary.wait_for(lambda: case.task(task, "awaiting_acceptance"), "Worker proposal missing after tool result")
    assert case.accept(run, case.completion(run), "accept-tool-worker")[0] == 200
    assert case.task(task, "completed")
    assert len([row for row in case.trace() if row["kind"] == "tool-result"]) == 1
    tasks.stop_parent(case)


def running_tool(case, **mode):
    marker = "synthetic-offline-marker:" + str(uuid.uuid4())
    source = "# " + marker + "\nwhile True: pass"
    task, run = begin(case, source, **mode)
    case.tool_probe = OwnedToolProbe(case.process, marker)
    ordinary.wait_for(case.tool_probe.running, "actual marked offline Python child did not start", seconds=3)
    return task, run


def direct_worker_stop_cancels_tool_and_preserves_parent(case):
    task, run = running_tool(case)
    status = ordinary.wait_for(lambda: (s if (s := exact_status(case, run))["capabilities"]["stop"] else None),
                               "Worker Stop unavailable during Python execution")
    (case.workspace / "progress-after-status").touch()
    ordinary.wait_for(lambda: any(row["kind"] == "extra-progress" for row in case.trace()), "streamed progress missing")
    assert case.request(case.path + "/stop", "POST", intent(status, "stop-tool-worker"))[0] == 200
    ordinary.wait_for(lambda: case.task(task, "cancelled"), "Worker Stop terminal proof missing")
    assert case.tool_probe.gone(), "physical Python reap must precede terminal Worker Stop"
    ordinary.wait_for(case.worker_gone, "owned Worker child did not exit")
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    assert not [row for row in case.trace() if row["kind"] == "tool-result"]
    assert not case.rows("SELECT delegation_id FROM worker_tool_results WHERE state='delivered'")
    tasks.stop_parent(case)


def ack_only_cleans_tool_without_claiming_cancelled(case):
    task, run = running_tool(case, ack_only=True)
    status = ordinary.wait_for(lambda: (s if (s := exact_status(case, run))["capabilities"]["stop"] else None),
                               "Worker Stop unavailable")
    assert case.request(case.path + "/stop", "POST", intent(status, "ack-only-tool-stop"))[0] == 200
    ordinary.wait_for(case.worker_gone, "ACK-only Worker and tool cleanup did not finish")
    assert case.tool_probe.gone()
    assert exact_status(case, run)["phase"] == "cancel_requested"
    assert not case.task(task, "cancelled")
    assert not [row for row in case.trace() if row["kind"] == "tool-result"]
    assert not case.rows("SELECT run_id FROM production_observations WHERE run_id=? AND kind='stopped'", (run,))


def revocation_quarantines_output_and_cleans_owned_tool(case):
    _, run = running_tool(case)
    case.revoke_machine()
    ordinary.wait_for(case.peer_gone, "revocation must reap native and offline children")
    assert case.tool_probe.gone()
    assert not [row for row in case.trace() if row["kind"] == "tool-result"]
    assert not case.rows("SELECT delegation_id FROM worker_tool_results WHERE state='delivered'")
    assert not case.rows("SELECT run_id FROM production_observations WHERE run_id=? AND kind IN ('stopped','completed_proposal')", (run,))


def unsupported_native_tool_never_gains_delegation(case):
    _, run = begin(case, "print('must-not-run')", unsupported=True)
    ordinary.wait_for(case.worker_gone, "unsupported native tool must close its Worker")
    assert not case.rows("SELECT id FROM worker_tool_delegations")
    assert not [row for row in case.trace() if row["kind"] == "tool-result"]
    assert not case.rows("SELECT run_id FROM production_observations WHERE run_id=? AND kind IN ('stopped','completed_proposal')", (run,))
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    tasks.stop_parent(case)


if __name__ == "__main__":
    worker.WorkerCase = ToolCase
    worker.SCENARIOS = [successful_result_is_correlated_then_requires_owner_acceptance,
                        direct_worker_stop_cancels_tool_and_preserves_parent,
                        ack_only_cleans_tool_without_claiming_cancelled,
                        revocation_quarantines_output_and_cleans_owned_tool,
                        unsupported_native_tool_never_gains_delegation]
    worker.main()
