"""Actual synthetic Stop/fresh-input Worker continuation and refusal evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from worker_continuation_case import ContinuationCase, ordinary
from worker_retirement_http import accepted_worker, stopped_worker, retired, tasks
from owned_native_probe import process_start


def begin(case):
    tasks.begin(case)
    case.actions = []


def stop_parent(case, key="parent-stop"):
    body, receipt = case.stop_run(case.parent["id"], key)
    ordinary.wait_for(lambda: case.phase("cancelled"), "genuine parent Stop missing")
    ordinary.wait_for(case.peer_gone, "original parent and Worker cleanup missing")
    case.actions.append({"stop_intent": body, "stop_receipt": receipt})
    return body, receipt


def no_resume(case):
    snapshot = case.snapshot()
    assert not snapshot["resume"]
    assert not snapshot["accepted_retirements"] and not snapshot["stopped_retirements"]
    return snapshot


def refused_fresh_input(case, number=3):
    before = case.trace()
    assert case.message(number)[0] == 202
    case.quiet()
    case.clean_stop()
    assert case.trace() == before, "unproven continuation launched or wrote native traffic"
    no_resume(case)
    case.checkpoint("continuation-refused")


def stop_fresh_worker_accept_and_final_configured_restart(case):
    begin(case)
    accepted_worker(case, "alpha")
    stopped_worker(case, "beta")
    code, old_input, _ = case.message(2)
    assert code == 202
    prior = case.parent.copy()
    first_identity = next(row for row in case.trace() if row["kind"] == "turn" and row["role"] == "deep")
    body, receipt = stop_parent(case)
    held = case.held(old_input["message_id"])
    no_resume(case)
    case.quiet()
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    (case.workspace / "gate-successor-progress").touch()
    case.fresh_after_stop(3)
    assert case.held(old_input["message_id"]) == held
    resumed_identity = [row for row in case.trace() if row["kind"] == "turn" and row["role"] == "deep"][-1]
    assert (resumed_identity["pid"], resumed_identity["process_start"]) != \
           (first_identity["pid"], first_identity["process_start"])
    assert process_start(first_identity["pid"]) != first_identity["process_start"]
    assert case.snapshot()["resume"] == [{"prior_run_id": prior["id"], "state": "confirmed"}]
    # Exact historical replay is receipt-only; altered/new intent cannot cancel
    # the successor or create another native process.
    ordinary.wait_for(lambda: any(row["kind"] == "progress-held" for row in case.trace()),
                      "successor progress gate missing")
    case.checkpoint("successor-running-before-progress")
    pending = case.snapshot()
    pending_trace = case.trace()
    (case.workspace / "release-successor-progress").touch()
    ordinary.wait_for(lambda: any(row["run_id"] == case.parent["id"] and row["kind"] == "progress"
                                  for row in case.snapshot()["observations"]), "successor Progress missing")
    before = case.snapshot()
    trace = case.trace()
    # Running precedes the separate Progress commit. Prove exactly that change,
    # then retain strict whole-state equality across the historical requests.
    added = [row for row in before["observations"] if row not in pending["observations"]]
    assert len(added) == 1 and added[0]["run_id"] == case.parent["id"] and added[0]["kind"] == "progress"
    assert pending["observations"] == [row for row in before["observations"] if row not in added]
    assert {key: value for key, value in before.items() if key != "observations"} == \
           {key: value for key, value in pending.items() if key != "observations"}
    assert trace == pending_trace
    case.checkpoint("before-historical-stop-replay")
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    assert case.request(case.path + "/stop", "POST", dict(body, request_key="new-old-parent-intent"))[0] == 503
    case.checkpoint("after-historical-stop-replay")
    assert case.snapshot() == before and case.trace() == trace
    stale = case.input("gamma")
    stale["expected_control_revision"] += 1
    assert case.request(case.path + "/worker-tasks", "POST", stale)[0] == 409
    assert case.snapshot() == before and case.trace() == trace
    accepted_worker(case, "gamma")
    case.release_parent(3)
    case.clean_stop()
    retired(case)
    assert len([row for row in case.snapshot()["runs"] if row["role"] == "worker"]) == 3
    case.fresh_restart(4)
    assert case.held(old_input["message_id"]) == held
    case.release_parent(4)
    case.clean_stop()
    assert sum(row["kind"] == "interrupt" and row["role"] == "deep" for row in case.trace()) == 1


def lost_worker_proof_survives_accepted_parent_history(case):
    begin(case)
    (case.workspace / "worker-exit-after-proposal").touch()
    _, task = case.create("alpha")
    run = tasks.task_running(case, task)["run_id"]
    identities = {(row["pid"], row["process_start"]) for row in case.trace() if row["role"] == "worker"}
    (case.workspace / "release-alpha").touch()
    ordinary.wait_for(lambda: case.task(task, "awaiting_acceptance"), "Worker proposal missing")
    ordinary.wait_for(lambda: all(process_start(pid) != start for pid, start in identities), "native fault did not occur")
    case.accept_run(run, "accept-before-continuation-refusal")
    # Complete the failed Worker's cleanup while the parent is still running.
    # This is fixture sequencing, never a substitute for its missing reap proof.
    ordinary.wait_for(case.worker_gone, "unproven accepted Worker cleanup incomplete")
    case.release_parent(1)
    first = case.parent["id"]
    assert case.message(2)[0] == 202
    case.parent = ordinary.wait_for(lambda: case.role_state("deep", "running"), "accepted same-child continuation missing")
    assert case.parent["id"] != first
    stop_parent(case, "parent-after-historical-proof-loss")
    refused_fresh_input(case)


def setup_without_worker_run_cannot_resume_parent(case):
    begin(case)
    (case.workspace / "hold-worker-setup").touch()
    _, task = case.create("alpha")
    ordinary.wait_for(lambda: any(row["kind"] == "setup-held" for row in case.trace()), "setup child missing")
    assert not [row for row in case.snapshot()["runs"] if row["role"] == "worker"]
    stop_parent(case, "stop-parent-with-setup")
    # The task never ran: it ends visibly failed with its recorded cause.
    failed = ordinary.wait_for(lambda: case.task(task, "failed"), "setup task failure missing")
    assert failed["failure_cause"] == "parent_left_running_during_setup" and failed["run_id"] is None
    refused_fresh_input(case)


def ack_only_worker_cannot_resume_parent(case):
    begin(case)
    (case.workspace / "worker-ack-only").touch()
    _, task = case.create("alpha")
    run = tasks.task_running(case, task)["run_id"]
    body, receipt = case.stop_run(run, "unknown-worker-stop")
    ordinary.wait_for(case.worker_gone, "unknown Worker cleanup missing")
    assert not any(row["run_id"] == run and row["kind"] == "stopped" for row in case.snapshot()["observations"])
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    stop_parent(case, "parent-after-unknown-worker")
    refused_fresh_input(case)


def ack_only_parent_never_opens_continuation(case):
    begin(case)
    accepted_worker(case, "alpha")
    (case.workspace / "deep-ack-only").touch()
    body, receipt = case.stop_run(case.parent["id"], "unknown-parent-stop")
    ordinary.wait_for(case.peer_gone, "unknown parent cleanup missing")
    assert case.phase("cancel_requested")
    assert not any(row["run_id"] == case.parent["id"] and row["kind"] == "stopped"
                   for row in case.snapshot()["observations"])
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    refused_fresh_input(case)


def revoked_auth_cannot_spend_retained_parent_proof(case):
    begin(case)
    accepted_worker(case, "alpha")
    stop_parent(case)
    case.revoke_machine()
    refused_fresh_input(case)


def changed_supervisor_fence_cannot_spend_retained_parent_proof(case):
    begin(case)
    accepted_worker(case, "alpha")
    stop_parent(case)
    case.refence_machine()
    refused_fresh_input(case)


SCENARIOS = [stop_fresh_worker_accept_and_final_configured_restart,
             lost_worker_proof_survives_accepted_parent_history,
             setup_without_worker_run_cannot_resume_parent,
             ack_only_worker_cannot_resume_parent,
             ack_only_parent_never_opens_continuation,
             revoked_auth_cannot_spend_retained_parent_proof,
             changed_supervisor_fence_cannot_spend_retained_parent_proof]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--case", choices=[test.__name__ for test in SCENARIOS])
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    ordinary.binary = args.binary.resolve(strict=True)
    report = {"binary_sha256": hashlib.sha256(ordinary.binary.read_bytes()).hexdigest(),
              "provider_kind": "synthetic-executable", "full_release_evidence": False, "cases": []}
    try:
        for test in SCENARIOS:
            if args.case and args.case != test.__name__:
                continue
            case = ContinuationCase()
            item = {"name": test.__name__, "status": "failed"}
            report["cases"].append(item)
            started = time.monotonic()
            failure = None
            try:
                case.setup()
                test(case)
            except BaseException as error:
                failure = error
                item["failure"] = repr(error)
            finally:
                item["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
                try:
                    item.update(trace=case.trace(), checkpoints=case.checkpoints,
                                snapshot=case.snapshot(), actions=getattr(case, "actions", []))
                except BaseException as error:
                    item["capture_failure"] = repr(error)
                    failure = failure or error
                try:
                    case.cleanup()
                except BaseException as error:
                    item["cleanup_failure"] = repr(error)
                    failure = failure or error
                item.update(server_exits=case.exits, server_diagnostics=case.logs,
                            fixture_home_removed=not case.root.exists(),
                            all_observed_native_gone=case.native_probe.gone())
            if failure is not None:
                raise failure
            assert item["fixture_home_removed"] and item["all_observed_native_gone"]
            item["status"] = "passed"
            print("Worker stopped continuation HTTP case passed:", test.__name__, flush=True)
    finally:
        with args.report.open("x") as output:
            os.chmod(args.report, 0o600)
            json.dump(report, output, indent=2)
            output.write("\n")


if __name__ == "__main__":
    main()
