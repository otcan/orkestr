"""Actual two-parent owner task scope; synthetic native peers and disposable state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from owned_execution_group import stop_request
from owned_native_probe import process_start
from worker_task_group_case import TaskGroupCase, ordinary


def cross_scope_refusals(case, tasks):
    before = case.capture("before_cross_scope")
    native = [case.trace_for(index) for index in range(2)]
    for index in range(2):
        other = 1 - index
        path = case.paths[index]
        foreign_input, foreign_receipt, foreign_run = tasks[other]
        own_run = tasks[index][2]
        parent = case.parents[other]["run_id"]
        # Historical exact replay and a fresh request must both stay scoped.
        case.expect(path + "/worker-tasks", 404, "POST", foreign_input)
        case.expect(path + "/worker-tasks", 503, "POST",
                    dict(foreign_input, request_key="scope-task:fresh-cross-parent"))
        for locator in (parent, foreign_run, own_run, foreign_receipt["task_id"]):
            case.expect(path + "/worker-tasks?parent_run_id=" + locator, 404)
        for locator in (parent, foreign_run, foreign_receipt["task_id"]):
            case.expect(path + "/execution?run_id=" + locator, 404)
        for run in (parent, foreign_run):
            status = case.exact(other, run)
            case.expect(path + "/stop", 503, "POST", stop_request(status, "cross-conversation-stop"))
        own = case.exact(index, own_run)
        case.expect(path + "/stop", 503, "POST",
                    dict(stop_request(own, "task-id-is-not-run-authority"),
                         run_id=foreign_receipt["task_id"]))
        for method, suffix, body in (("POST", "/hold", {}), ("DELETE", "/payload", None)):
            case.expect(path + "/worker-tasks/" + foreign_receipt["task_id"] + suffix,
                        404, method, body)
        page = case.expect(path + "/workers", 200)
        assert page["conversation_id"] == case.conversations[index]
        assert len(page["workers"]) == 1
        found = page["workers"][0]
        assert found["run_id"] == own_run and found["parent_run_id"] == case.parents[index]["run_id"]
        assert found["source_message_id"] == tasks[index][1]["source_message_id"]
        assert found["source_event_id"] == tasks[index][1]["source_event_id"]
        own_tasks = case.task_list(index)["tasks"]
        assert len(own_tasks) == 1 and own_tasks[0]["task"] == tasks[index][1]
    assert case.capture("after_cross_scope") == before, "refused locators changed durable execution/task data"
    assert [case.trace_for(index) for index in range(2)] == native, "refusal caused native provider I/O"


def two_parent_task_scope(case):
    case.begin()
    tasks = [case.create(index) for index in range(2)]
    initial = case.capture("four_live_executions")
    owners, sessions, native_ids, host_pids, namespaces = set(), set(), set(), set(), set()
    for index, snapshot in enumerate(initial):
        runs = {row["role"]: row for row in snapshot["runs"]}
        assert len(snapshot["runs"]) == 2 and set(runs) == {"deep", "worker"}
        assert runs["deep"]["id"] == case.parents[index]["run_id"]
        assert runs["worker"]["id"] == tasks[index][2]
        assert runs["worker"]["parent_session_id"] == runs["deep"]["session_id"]
        for role, row in runs.items():
            peer = case.peer(index, role)
            assert peer["native"] == row["native_session_id"]
            assert case.alive(index, role)
            owners.add(row["owner_id"])
            sessions.add(row["session_id"])
            native_ids.add(row["native_session_id"])
            host_pids.add(peer["pid"])
            namespaces.add(peer["pid_namespace"])
        turns = [row for row in case.trace_for(index) if row["kind"] == "turn"]
        assert len(turns) == 2
        assert {row["message"] for row in turns} == {case.messages[index]["message_id"]}
        assert [row["instructions"] for row in turns if row["role"] == "worker"] == [tasks[index][0]["instructions"]]
    assert len(owners) == 1 and all(len(values) == 4 for values in (sessions, native_ids, host_pids, namespaces))
    cross_scope_refusals(case, tasks)

    before = case.capture("before_worker_a_stop")
    sibling_trace = case.trace_for(1)
    worker_a = tasks[0][2]
    request = stop_request(case.exact(0, worker_a), "stop-only-worker-a")
    receipt = case.expect(case.paths[0] + "/stop", 200, "POST", request)
    assert receipt["run_id"] == worker_a and receipt["conversation_id"] == case.conversations[0]
    ordinary.wait_for(lambda: case.task(0, tasks[0][1], "cancelled"), "Worker A needs actual terminal Stop proof")
    ordinary.wait_for(lambda: not case.alive(0, "worker"), "Worker A native process was not reaped")
    for index, role, run in ((0, "deep", case.parents[0]["run_id"]),
                             (1, "deep", case.parents[1]["run_id"]), (1, "worker", tasks[1][2])):
        assert case.running(index, run) and case.alive(index, role), "Stop A affected a distinct live execution"
    after = case.capture("after_worker_a_stop")
    assert after[1] == before[1] and case.trace_for(1) == sibling_trace
    assert after[0]["inbox"] == before[0]["inbox"]
    assert [row["run_id"] for row in after[0]["cancellations"]] == [worker_a]
    assert [row["run_id"] for row in after[0]["observations"] if row["kind"] == "stopped"] == [worker_a]
    assert not after[0]["acceptances"]
    interrupts = [row for row in case.trace() if row["kind"] == "interrupt"]
    assert len(interrupts) == 1 and interrupts[0]["native"] == case.peer(0, "worker")["native"]
    assert case.expect(case.paths[0] + "/stop", 200, "POST", request) == receipt
    case.expect(case.paths[1] + "/stop", 503, "POST", request)
    assert case.capture("after_stop_replays") == after

    # Native completion proposes a result; only the current owner accepts it.
    (case.workspaces[1] / "release-beta").touch()
    ordinary.wait_for(lambda: case.task(1, tasks[1][1], "awaiting_acceptance"), "Worker B proposal missing")
    assert case.task(0, tasks[0][1], "cancelled")
    event = case.completion(1, tasks[1][2])
    before_accept = case.capture("before_owner_acceptance")
    assert not any(snapshot["acceptances"] for snapshot in before_accept)
    code, current, _ = case.request(case.paths[1] + "/execution")
    assert code == 200
    acceptance = {"run_id": tasks[1][2], "completion_event_id": event,
                  "expected_revision": current["revision"], "request_key": "accept-only-worker-b"}
    case.expect(case.paths[0] + "/accept", 409, "POST", acceptance)
    case.expect(case.paths[1] + "/accept", 409, "POST", dict(acceptance, run_id=worker_a))
    assert case.capture("after_wrong_acceptance") == before_accept
    accepted = case.expect(case.paths[1] + "/accept", 200, "POST", acceptance)
    assert accepted["outcome"] == "succeeded" and accepted["run_id"] == tasks[1][2]
    assert accepted["completion_event_id"] == event
    assert case.task(1, tasks[1][1], "completed") and case.task(0, tasks[0][1], "cancelled")
    after_accept = case.capture("after_owner_acceptance")
    assert after_accept[0] == before_accept[0]
    assert [row["run_id"] for row in after_accept[1]["acceptances"]] == [tasks[1][2]]
    assert not after_accept[1]["cancellations"]
    assert case.expect(case.paths[1] + "/accept", 200, "POST", acceptance) == accepted
    for index in range(2):
        assert case.running(index, case.parents[index]["run_id"]) and case.alive(index, "deep")
        assert len([row for row in case.trace_for(index) if row["kind"] == "turn"]) == 2
        assert case.expect(case.paths[index] + "/worker-tasks", 200, "POST", tasks[index][0]) == tasks[index][1]
    # Explicitly stop each surviving parent through its own authenticated route.
    for index in range(2):
        parent = case.parents[index]["run_id"]
        case.expect(case.paths[index] + "/stop", 200, "POST",
                    stop_request(case.exact(index, parent), f"finish-parent-{index}"))
        ordinary.wait_for(lambda: case.exact(index, parent)["phase"] == "cancelled", "parent terminal proof")
        ordinary.wait_for(lambda: case.probes[index].gone(), "selected parent tree cleanup")
        if index == 0:
            assert case.running(1, case.parents[1]["run_id"]) and case.alive(1, "deep")
    final = case.capture("final")
    assert len(final[0]["cancellations"]) == 2 and len(final[1]["cancellations"]) == 1
    assert sum(len(snapshot["acceptances"]) for snapshot in final) == 1
    assert len(case.trace()) <= 32, "unexpected native retry/redispatch"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    ordinary.binary = args.binary.resolve(strict=True)
    report = {"scenario": "two_live_parent_worker_task_scope", "status": "failed",
              "provider_kind": "synthetic-executable", "full_release_evidence": False,
              "binary_sha256": hashlib.sha256(ordinary.binary.read_bytes()).hexdigest(),
              "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    case = TaskGroupCase()
    started, failure, process = time.monotonic(), None, None
    try:
        case.setup()
        two_parent_task_scope(case)
    except BaseException as error:
        failure = error
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        report["evidence"] = case.evidence
        try:
            report["trace"] = case.trace()
        except BaseException as error:
            report["trace_error"] = f"{type(error).__name__}: {error}"
            failure = failure or error
        process = case.process
        server_start = process_start(process.pid) if process else None
        try:
            case.cleanup()
            report["cleanup"] = {"temporary_home_removed": not case.root.exists(),
                "all_observed_native_identities_gone": all(probe.gone() for probe in case.probes),
                "server_pid": process.pid if process else None,
                "server_start": server_start,
                "server_gone": process is None or process_start(process.pid) != server_start,
                "server_exit": process.returncode if process else None}
            assert all(report["cleanup"][key] for key in (
                "temporary_home_removed", "all_observed_native_identities_gone", "server_gone"))
            assert process is not None and process.returncode == 0, "owned server cleanup did not exit normally"
        except BaseException as error:
            report["cleanup_error"] = f"{type(error).__name__}: {error}"
            failure = failure or error
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
        if failure is None:
            report["status"] = "passed"
        if args.report:
            with args.report.open("x") as stream:
                os.chmod(args.report, 0o600)
                json.dump(report, stream, indent=2)
                stream.write("\n")
    if failure is not None:
        raise failure
    print("Worker task scope HTTP case passed: two_live_parents", flush=True)


if __name__ == "__main__":
    main()
