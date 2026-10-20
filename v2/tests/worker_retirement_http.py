"""Actual synthetic HTTP/process proof aggregation; never production/account state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from owned_native_probe import process_start
from worker_retirement_case import RetirementCase, ordinary, tasks


def begin(case):
    tasks.begin(case)


def accepted_worker(case, name):
    _, task = case.create(name)
    run = tasks.task_running(case, task)["run_id"]
    case.trace()
    (case.workspace / f"release-{name}").touch()
    ordinary.wait_for(lambda: case.task(task, "awaiting_acceptance"), "Worker proposal missing")
    case.accept_run(run, "accept-" + name)
    ordinary.wait_for(case.worker_gone, "accepted Worker native tree not reaped")
    return task, run


def stopped_worker(case, name):
    _, task = case.create(name)
    run = tasks.task_running(case, task)["run_id"]
    case.trace()
    body, receipt = case.stop_run(run, "stop-" + name)
    ordinary.wait_for(lambda: case.task(task, "cancelled"), "Worker terminal Stop missing")
    ordinary.wait_for(case.worker_gone, "stopped Worker native tree not reaped")
    return task, run, body, receipt


def retired(case, kind="accepted_retirements"):
    snapshot = case.snapshot()
    assert len(snapshot[kind]) == 1, "all original Worker reap proofs must permit exact parent retirement"
    assert snapshot[kind][0]["prior_run_id"] == case.parent["id"]
    assert not any(row["state"] in ("queued", "claimed") or row["claim_hash"] is not None
                   for row in snapshot["tasks"])
    case.checkpoint("retired")


def refused(case):
    state = case.snapshot()
    assert not state["accepted_retirements"] and not state["stopped_retirements"], \
        "a canonical terminal label or empty child set cannot replace original proof"
    case.checkpoint("refused-retirement")
    case.refuse_restart()


def accepted_and_stopped_workers_restart(case):
    begin(case)
    alpha, arun = accepted_worker(case, "alpha")
    beta, brun, stop, receipt = stopped_worker(case, "beta")
    assert arun != brun and case.task(alpha, "completed") and case.task(beta, "cancelled")
    case.release_parent(1)
    case.clean_stop()
    retired(case)
    historical = case.snapshot()["tasks"]
    case.fresh_restart(2)
    # Historical Stop cannot be re-delivered into the new factory.
    assert case.request(case.path + "/stop", "POST", stop)[0] == 503
    assert case.snapshot()["tasks"] == historical
    assert sum(row["kind"] == "interrupt" and row["role"] == "worker" for row in case.trace()) == 1
    case.release_parent(2)
    case.clean_stop()


def parent_continuations_accumulate_original_proofs(case):
    begin(case)
    accepted_worker(case, "alpha")
    case.release_parent(1)
    first = case.parent
    first_native = [row for row in case.trace() if row["kind"] == "turn" and row["role"] == "deep"][0]
    assert case.message(2)[0] == 202
    case.parent = ordinary.wait_for(lambda: case.role_state("deep", "running"), "same-child successor missing")
    assert case.parent["id"] != first["id"]
    assert case.parent["native_session_id"] == first["native_session_id"]
    ordinary.wait_for(lambda: case.task_list()["can_create"], "successor task scheduler missing")
    accepted_worker(case, "beta")
    second_native = [row for row in case.trace() if row["kind"] == "turn" and row["role"] == "deep"][-1]
    assert (second_native["pid"], second_native["process_start"]) == (first_native["pid"], first_native["process_start"])
    case.release_parent(2)
    case.clean_stop()
    retired(case)
    assert len([row for row in case.snapshot()["runs"] if row["role"] == "worker"]) == 2
    case.fresh_restart(3)
    case.release_parent(3)
    case.clean_stop()


def stopped_parent_preserves_terminal_workers_and_held_input(case):
    begin(case)
    accepted_worker(case, "alpha")
    stopped_worker(case, "beta")
    code, held, _ = case.message(2)
    assert code == 202
    case.stop_run(case.parent["id"], "stop-parent")
    ordinary.wait_for(lambda: case.phase("cancelled"), "parent terminal Stop missing")
    ordinary.wait_for(case.peer_gone, "stopped parent cleanup missing")
    case.clean_stop()
    retired(case, "stopped_retirements")
    case.fresh_restart(3)
    assert not any(row["message_id"] == held["message_id"] for row in case.snapshot()["runs"])
    held_row = next(row for row in case.snapshot()["inbox"] if row["message_id"] == held["message_id"])
    assert held_row["state"] == "queued" and held_row["admitted_run_id"] is None
    case.release_parent(3)
    case.clean_stop()


def configured_without_launched_workers_needs_no_invented_proof(case):
    begin(case)
    assert not [row for row in case.trace() if row["role"] == "worker"]
    case.release_parent(1)
    case.clean_stop()
    retired(case)
    case.fresh_restart(2)
    case.release_parent(2)
    case.clean_stop()
    assert not [row for row in case.trace() if row["role"] == "worker"]



def unaccepted_parent_shutdown_cannot_retire(case):
    begin(case)
    (case.workspace / "release-deep-1").touch()
    ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "parent proposal missing")
    case.clean_stop()
    assert not case.snapshot()["accepted_retirements"]
    assert not case.snapshot()["stopped_retirements"]
    assert not any(row["kind"] == "stopped" for row in case.snapshot()["observations"])
    refused(case)


def setup_only_child_refuses_even_without_durable_worker_run(case):
    begin(case)
    (case.workspace / "hold-worker-setup").touch()
    _, task = case.create("alpha")
    ordinary.wait_for(lambda: any(row["kind"] == "setup-held" for row in case.trace()), "setup child not observed")
    assert not [row for row in case.snapshot()["runs"] if row["role"] == "worker"]
    case.stop_run(case.parent["id"], "stop-parent-during-setup")
    ordinary.wait_for(lambda: case.phase("cancelled"), "parent Stop missing during unproven setup")
    ordinary.wait_for(case.peer_gone, "setup child cleanup missing")
    # The task never ran: it ends visibly failed with its recorded cause.
    failed = ordinary.wait_for(lambda: case.task(task, "failed"), "setup task failure missing")
    assert failed["failure_cause"] == "parent_left_running_during_setup" and failed["run_id"] is None
    case.clean_stop()
    refused(case)


def ack_only_worker_refuses_despite_physical_cleanup(case):
    begin(case)
    (case.workspace / "worker-ack-only").touch()
    _, task = case.create("alpha")
    run = tasks.task_running(case, task)["run_id"]
    case.trace()
    body, receipt = case.stop_run(run, "worker-ack-only")
    ordinary.wait_for(case.worker_gone, "unknown Worker physical cleanup missing")
    assert not any(row["run_id"] == run and row["kind"] == "stopped" for row in case.snapshot()["observations"])
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    case.stop_run(case.parent["id"], "parent-after-worker-unknown")
    ordinary.wait_for(lambda: case.phase("cancelled"), "parent Stop missing")
    case.clean_stop()
    refused(case)


def lost_native_proof_refuses_after_worker_owner_acceptance(case):
    begin(case)
    (case.workspace / "worker-exit-after-proposal").touch()
    _, task = case.create("alpha")
    run = tasks.task_running(case, task)["run_id"]
    identities = {(row["pid"], row["process_start"]) for row in case.trace() if row["role"] == "worker"}
    assert len(identities) == 1
    (case.workspace / "release-alpha").touch()
    ordinary.wait_for(lambda: case.task(task, "awaiting_acceptance"), "proposal before native death missing")
    ordinary.wait_for(lambda: all(process_start(pid) != start for pid, start in identities), "synthetic native did not exit")
    case.accept_run(run, "accepted-after-unproven-death")
    assert case.task(task, "completed")
    case.release_parent(1)
    case.clean_stop()
    refused(case)


def revoked_context_cannot_spend_retained_worker_proofs(case):
    begin(case)
    accepted_worker(case, "alpha")
    case.release_parent(1)
    case.revoke_machine()
    case.clean_stop()
    refused(case)


SCENARIOS = [accepted_and_stopped_workers_restart,
             parent_continuations_accumulate_original_proofs,
             stopped_parent_preserves_terminal_workers_and_held_input,
             configured_without_launched_workers_needs_no_invented_proof,
             unaccepted_parent_shutdown_cannot_retire,
             setup_only_child_refuses_even_without_durable_worker_run,
             ack_only_worker_refuses_despite_physical_cleanup,
             lost_native_proof_refuses_after_worker_owner_acceptance,
             revoked_context_cannot_spend_retained_worker_proofs]


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
            case = RetirementCase()
            item = {"name": test.__name__, "status": "failed"}
            report["cases"].append(item)
            beginning = time.monotonic()
            try:
                case.setup()
                test(case)
            finally:
                item["elapsed_ms"] = round((time.monotonic() - beginning) * 1000, 3)
                try:
                    item.update(trace=case.trace(), checkpoints=case.checkpoints, snapshot=case.snapshot())
                finally:
                    case.cleanup()
                    item.update(server_exits=case.exits, server_diagnostics=case.logs,
                                fixture_home_removed=not case.root.exists(),
                                all_observed_native_gone=case.native_probe.gone())
            item["status"] = "passed"
            print("Worker original reap HTTP case passed:", test.__name__, flush=True)
    finally:
        with args.report.open("x") as output:
            os.chmod(args.report, 0o600)
            json.dump(report, output, indent=2)
            output.write("\n")


if __name__ == "__main__":
    main()
