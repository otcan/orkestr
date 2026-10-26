"""One finite real-HTTP concurrent-window role/queue/resume fixture. No provider.

Run as root with a server built from the same source. The package and fixed
native ELF are entirely disposable; retained evidence contains synthetic data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import time

from owned_execution_http import wait_for
from owned_native_probe import process_start
from service_roles_case import ServiceRolesCase


def path(conversation):
    return "/api/v2/conversations/" + conversation


def expect(case, route, code=200, method="GET", body=None):
    actual, value, _ = case.request(route, method, body)
    case.trace()
    assert actual == code, (route, actual, value)
    return value


def status(case, conversation, role="deep", phase=None, previous=None, run=None):
    route = path(conversation) + ("/fast" if role == "fast" else "") + "/execution"
    if run:
        route += "?run_id=" + run
    code, value, _ = case.request(route)
    case.trace()
    if code == 204:
        return None
    assert code == 200, (route, code, value)
    assert value["conversation_id"] == conversation
    assert not run or value["run_id"] == run
    assert value["phase"] not in ("blocked", "failed", "cancel_requested"), value["phase"]
    if phase and value["phase"] != phase or previous and value["run_id"] == previous:
        return None
    return value


def ready(case, conversation, role, phase="awaiting_acceptance", **kwargs):
    return wait_for(lambda: status(case, conversation, role, phase, **kwargs),
                    f"{role} {phase} in {conversation}", 20)


def intake(case, conversation, key, number):
    return expect(case, path(conversation) + "/messages", 202, "POST",
                  {"client_message_id": key, "text": f"synthetic ordinary HTTP input {number}"})


def window_request(receipt, key, generation=0, predecessor=None):
    return {"request_key": "window:" + key, "input_message_id": receipt["message_id"],
            "input_event_id": receipt["event_id"], "input_request_key": key,
            "expected_generation": generation, "window_id": None,
            "predecessor_window_id": predecessor}


def accept(case, conversation, projection, key):
    # The revision is global to this conversation; independently emitting roles
    # may advance it. Read the exact proposal immediately before the one action.
    run = projection["run_id"]
    role = "fast" if projection.get("_role") == "fast" else "deep"
    current = ready(case, conversation, role, run=run)
    body = {**current["acceptance_candidate"], "expected_revision": current["revision"], "request_key": key}
    result = expect(case, path(conversation) + "/accept", 200, "POST", body)
    assert result["run_id"] == run and result["outcome"] == "succeeded"
    return result


def review(case, conversation):
    """These fixtures accept each proposal by hand: opt the conversation out of
    the default server owner auto-accept before any of its turns runs."""
    update = {"expected_revision": 0, "provider": "codex", "honor_no_reply": True,
              "review_before_accepting": True}
    settings = expect(case, path(conversation) + "/settings", 200, "PUT", update)
    assert settings["review_before_accepting"] is True, settings


def windows(case):
    return case.rows("SELECT id,conversation_id,generation,state,terminal_run_id FROM execution_windows ORDER BY rowid")


def run(case):
    first = case.conversation
    second = expect(case, "/api/v2/conversations", 201, "POST",
                    {"client_request_id": "synthetic:second", "name": "Synthetic second thread"})["conversation_id"]
    assert first != second
    review(case, first)
    review(case, second)
    assert expect(case, "/api/v2/beta?conversation_id=" + second)["conversation_id"] == second
    key = "first:1"
    admission = expect(case, path(first) + "/window", 201, "POST", window_request(intake(case, first, key, 1), key))
    a = admission["status"]
    assert a["generation"] == 1 and a["conversation_id"] == first
    deep = ready(case, first, "deep", "running")
    fast = ready(case, first, "fast")
    assert deep["run_id"] != fast["run_id"]
    initial = case.rows("SELECT id,role,session_id,native_session_id,context_id,incarnation_id,message_id FROM production_runs")
    assert len(initial) == 2 and {row["role"] for row in initial} == {"fast", "deep"}
    assert len({row["session_id"] for row in initial}) == len({row["native_session_id"] for row in initial}) == 2
    assert len({row["context_id"] for row in initial}) == len({row["message_id"] for row in initial}) == 1
    tasks = path(first) + "/worker-tasks?parent_run_id=" + deep["run_id"]
    wait_for(lambda: expect(case, tasks)["can_create"], "owned Worker task scheduler")
    exact = ready(case, first, "deep", "running", run=deep["run_id"])
    # Observe the original live native before allowing its immediate proposal
    # retirement. Namespace trace rows are locators, never replacement witnesses.
    case.fixture.write_private(case.workspaces["worker-0"] / "mode", b"hold")
    task = expect(case, path(first) + "/worker-tasks", 200, "POST",
                  {"parent_run_id": deep["run_id"], "expected_control_revision": exact["control_revision"],
                   "request_key": "synthetic:worker", "title": "Synthetic Worker task",
                   "instructions": "synthetic ordinary HTTP input 41", "lifetime_ms": 30000})
    def task_row():
        found = [row for row in expect(case, tasks)["tasks"] if row["task"]["task_id"] == task["task_id"]]
        assert len(found) == 1
        return found[0]
    live_worker = wait_for(lambda: (row if (row := task_row())["phase"] == "running" else None),
                           "live original Worker", 20)
    ready(case, first, "deep", "running", run=live_worker["run_id"])
    (case.workspaces["worker-0"] / "release-41").touch()
    worker = wait_for(lambda: (row if (row := task_row())["phase"] == "awaiting_acceptance" else None),
                      "real Worker proposal", 20)
    worker_status = ready(case, first, "deep", run=worker["run_id"])
    assert worker_status["run_id"] not in (deep["run_id"], fast["run_id"])
    worker_receipt = accept(case, first, worker_status, "accept:worker")
    assert status(case, first, phase="running")["run_id"] == deep["run_id"]
    # Concurrency: the second conversation opens its own window while the
    # first conversation's Deep turn is still running in its own window.
    bkey = "second:1"
    pending_b = window_request(intake(case, second, bkey, 2), bkey)
    second_admission = expect(case, path(second) + "/window", 201, "POST", pending_b)["status"]
    assert second_admission["generation"] == 1 and second_admission["conversation_id"] == second
    bdeep_running = ready(case, second, "deep", "running")
    assert status(case, first, phase="running")["run_id"] == deep["run_id"]
    live = {row["conversation_id"] for row in windows(case) if row["state"] == "active"}
    assert live == {first, second}, live
    managed = case.rows("SELECT conversation FROM windows WHERE state='active'", manager=True)
    assert {row["conversation"] for row in managed} == {first, second}
    # Capacity is two: a third conversation's intent is durably queued, not refused.
    third = expect(case, "/api/v2/conversations", 201, "POST",
                   {"client_request_id": "synthetic:third", "name": "Synthetic third thread"})["conversation_id"]
    review(case, third)
    ckey = "third:1"
    pending_c = window_request(intake(case, third, ckey, 4), ckey)
    queued = expect(case, path(third) + "/window", 202, "POST", pending_c)
    assert queued["state"] == "queued" and queued["position"] == 1, queued
    assert expect(case, path(third) + "/window", 202, "POST", pending_c) == queued
    queue = expect(case, path(third) + "/window/queue")
    assert (queue["capacity"], queue["active"], queue["queued_total"]) == (2, 2, 1), queue
    assert [entry["request_key"] for entry in queue["entries"]] == [pending_c["request_key"]]
    assert not [row for row in windows(case) if row["conversation_id"] == third]
    # The second conversation progresses independently of the held first.
    (case.workspaces["deep"] / "release-2").touch()
    bdeep = ready(case, second, "deep")
    assert bdeep["run_id"] == bdeep_running["run_id"]
    assert status(case, first, phase="running")["run_id"] == deep["run_id"]
    # Both roles settle before either acceptance: the revision is per conversation.
    bfast = ready(case, second, "fast")
    accept(case, second, bdeep, "accept:second-deep")
    bfast["_role"] = "fast"
    accept(case, second, bfast, "accept:second-fast")
    assert status(case, first, phase="running")["run_id"] == deep["run_id"]
    # The second window is now idle (every role accepted). Under capacity
    # pressure the dispatcher retires it, and the queued third starts by itself.
    cdeep_running = wait_for(lambda: status(case, third, phase="running"), "queued third Deep turn", 30)
    assert next(row for row in windows(case) if row["conversation_id"] == second)["state"] == "closed"
    dispatched = expect(case, path(third) + "/window", 202, "POST", pending_c)
    assert dispatched["state"] == "dispatched" and dispatched["window_id"], dispatched
    assert expect(case, path(third) + "/window/queue")["entries"] == []
    fast["_role"] = "fast"
    fast_receipt = accept(case, first, fast, "accept:first-fast")
    (case.workspaces["deep"] / "release-1").touch()
    deep_receipt = accept(case, first, ready(case, first, "deep"), "accept:first-deep")
    # Deep stays in "hold" mode: every Deep turn here needs its own release file.
    # An idle window stays open for follow-ups: the next input joins it.
    akey = "first:2"
    pending_a = {**window_request(intake(case, first, akey, 3), akey, 1), "window_id": a["window_id"]}
    resumed = expect(case, path(first) + "/window", 201, "POST", pending_a)["status"]
    assert resumed["generation"] == 1 and resumed["window_id"] == a["window_id"]
    (case.workspaces["deep"] / "release-3").touch()
    adeep = ready(case, first, "deep", previous=deep["run_id"])
    afast = ready(case, first, "fast", previous=fast["run_id"])
    afast["_role"] = "fast"
    accept(case, first, afast, "accept:resumed-fast")
    accept(case, first, adeep, "accept:resumed-deep")
    # The idle warm Fast native dies between turns (OOM or a resource-monitor
    # kill). Fast must rotate to a fresh session, not end for the window.
    warm = case.rows("SELECT native_session_id FROM production_runs WHERE id=?",
                     (afast["run_id"],))[0]["native_session_id"]
    victims = [row for row in case.trace()
               if row["kind"] == "ready" and row["role"] == "fast" and row["native"] == warm]
    assert len(victims) == 1, victims
    victim = victims[0]
    assert process_start(victim["pid"]) == victim["process_start"]
    os.kill(victim["pid"], signal.SIGKILL)
    wait_for(lambda: process_start(victim["pid"]) != victim["process_start"] or None,
             "killed idle Fast native", 10)
    time.sleep(1)  # The idle Fast wait observes its broker every 100 ms.
    dkey = "first:3"
    pending_d = {**window_request(intake(case, first, dkey, 5), dkey, 1), "window_id": a["window_id"]}
    rejoined = expect(case, path(first) + "/window", 201, "POST", pending_d)["status"]
    assert rejoined["window_id"] == a["window_id"]
    (case.workspaces["deep"] / "release-5").touch()
    ddeep = ready(case, first, "deep", previous=adeep["run_id"])
    dfast = ready(case, first, "fast", previous=afast["run_id"])
    dfast["_role"] = "fast"
    accept(case, first, dfast, "accept:fresh-after-kill-fast")
    accept(case, first, ddeep, "accept:fresh-after-kill-deep")
    (case.workspaces["deep"] / "release-4").touch()
    cdeep = ready(case, third, "deep", run=cdeep_running["run_id"])
    cfast = ready(case, third, "fast")
    accept(case, third, cdeep, "accept:third-deep")
    cfast["_role"] = "fast"
    accept(case, third, cfast, "accept:third-fast")
    # Both remaining windows are idle; later fresh windows reclaim them inline.
    runs = case.rows("SELECT id,role,conversation_id,state,session_id,native_session_id,context_id,incarnation_id FROM production_runs ORDER BY rowid")
    assert len(runs) == 11 and all(row["state"] == "succeeded" for row in runs)
    for role in ("deep", "fast"):
        rows = [row for row in runs if row["role"] == role and row["conversation_id"] == first]
        assert len(rows) == 3
        # A follow-up in the same window reuses the warm accepted Fast child;
        # after the idle Fast native was killed the next input starts fresh.
        identities = 2 if role == "fast" else 1
        assert len({row["session_id"] for row in rows}) == len({row["native_session_id"] for row in rows}) == identities
        if role == "fast":
            assert rows[0]["native_session_id"] == rows[1]["native_session_id"] != rows[2]["native_session_id"]
            assert rows[2]["id"] == dfast["run_id"]
        assert len({row["incarnation_id"] for row in rows}) == 1
        for conversation in (second, third):
            other = next(row for row in runs if row["role"] == role and row["conversation_id"] == conversation)
            assert other["native_session_id"] != rows[0]["native_session_id"]
            assert other["context_id"] not in {row["context_id"] for row in rows}
    trace = case.trace()
    assert len([row for row in trace if row["kind"] == "turn"]) == 11
    for role in ("deep", "fast"):
        setups = 4 if role == "fast" else 3
        assert [row["resumed"] for row in trace if row["kind"] == "ready" and row["role"] == role] == [False] * setups
    digests = case.rows("SELECT run_id,digest_text,cutoff_sequence FROM production_fast_digests")
    assert len(digests) == 5 and all(len(row["digest_text"].encode()) <= 8192 for row in digests)
    # The fresh session after the kill gets the full digest, as on first launch.
    fresh = [row["digest_text"] for row in digests if row["run_id"] == dfast["run_id"]]
    assert len(fresh) == 1 and not fresh[0].startswith("Conversation update"), fresh
    # A fresh Fast session gets the full digest; the warm continuation already
    # has its own turns and gets only Deep's answer accepted since.
    update = [row["digest_text"] for row in digests if row["run_id"] == afast["run_id"]]
    assert len(update) == 1 and update[0].startswith("Conversation update since your previous turn"), update
    assert case.rows("SELECT count(*) AS n FROM production_acceptances") == [{"n": 11}]
    from service_roles_retention import run as retained_workers
    retention = retained_workers(case)
    case.stop()
    final = windows(case)
    assert len(final) == 5 and all(row["state"] == "closed" for row in final)
    manager = case.rows("SELECT conversation,generation,state FROM windows ORDER BY rowid", manager=True)
    assert len(manager) == 5 and all(row["state"] == "retired" for row in manager)
    return {"windows": final, "manager": manager, "runs": runs, "trace": trace,
            "first_acceptances": [worker_receipt, fast_receipt, deep_receipt],
            "retained_worker_cases": retention}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    record = {"source": args.source, "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              "actual_provider": False, "passed": False}
    case = ServiceRolesCase(args.source)
    record["fixture"] = str(case.root)
    started = time.monotonic()
    try:
        case.setup()
        record.update(run(case), passed=True)
    except BaseException as error:
        record["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        try:
            case.cleanup()
            record["cleanup"] = {"originals_gone": True, "forced": case.forced,
                                 "observed": [{"pid": pid, "start": start} for pid, start in case.known]}
        except BaseException as error:
            record["passed"] = False
            record["cleanup_error"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            record["elapsed_seconds"] = round(time.monotonic() - started, 3)
            record["cleanup_observations"] = [{"pid": pid, "start": start,
                "gone": __import__("owned_native_probe").process_start(pid) != start}
                for pid, start in case.known]
            with args.report.open("x") as stream:
                args.report.chmod(0o600)
                json.dump(record, stream, indent=2)
                stream.write("\n")
            print(json.dumps({key: record[key] for key in ("fixture", "passed", "elapsed_seconds")}), flush=True)
