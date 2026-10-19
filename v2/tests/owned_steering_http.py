"""Actual ordinary HTTP, Core ledger and sole native writer; synthetic provider."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import time
import uuid
from owned_execution_http import Case, wait_for


def rows(case, query, parameters=()):
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        return db.execute(query, parameters).fetchall()


def configure(case):
    case.stop()
    case.configure()
    shutil.copyfile(Path(__file__).with_name("owned_steering_peer.py"), case.root / "synthetic-provider")


def running(case, number=1):
    assert case.message(number)[0] == 202
    return wait_for(lambda: available(case), "bound native turn must advertise steering")


def available(case):
    status = case.phase("running")
    return status if status and status["capabilities"] == {"stop": True, "steer": True} else None


def intent(status, key="steer:one", text="synthetic steering input"):
    return {"control": {"run_id": status["run_id"], "expected_revision": status["revision"],
            "expected_control_revision": status["control_revision"], "request_key": key}, "text": text}


def submitted(case, request, disposition="reserved"):
    code, receipt, headers = case.request(case.path + "/steer", "POST", request)
    assert code == 200, (code, receipt)
    assert receipt["disposition"] == disposition
    assert headers["Cache-Control"] == "no-store"
    assert set(receipt) == {"conversation_id", "run_id", "request_key", "message_id", "event_id", "scope_sequence", "disposition"}
    assert receipt["run_id"] == request["control"]["run_id"]
    return receipt


def delivery(case, key="steer:one"):
    code, value, headers = case.request(case.path + "/steering/" + key)
    assert code == 200 and headers["Cache-Control"] == "no-store"
    return value


def acknowledged(case, key="steer:one"):
    value = delivery(case, key)
    return value if value["state"] == "acknowledged" else None


def accept(case, turn):
    (case.workspace / f"complete-{turn}").touch()
    state = wait_for(lambda: case.phase("awaiting_acceptance"), "native completion proposal missing")
    request = {**state["acceptance_candidate"], "expected_revision": state["revision"], "request_key": f"accept:{turn}"}
    code, receipt, _ = case.request(case.path + "/accept", "POST", request)
    assert code == 200 and receipt["outcome"] == "succeeded"
    return state


def success_and_replay(case):
    configure(case)
    case.start(configured=True)
    state = running(case)
    request = intent(state)
    receipt = submitted(case, request)
    done = wait_for(lambda: acknowledged(case), "actual native steer acknowledgement missing")
    assert done["written_bytes"] > 0 and done["receipt"] == receipt
    assert case.request(case.path + "/steer", "POST", request)[:2] == (200, receipt)
    changed = {**request, "text": "changed request text"}
    assert case.request(case.path + "/steer", "POST", changed)[0] == 409
    assert case.phase("running")["run_id"] == state["run_id"]
    assert rows(case, "SELECT count(*) FROM production_acceptances") == [(0,)]
    assert rows(case, "SELECT count(*) FROM production_runs") == [(1,)]
    assert rows(case, "SELECT count(*) FROM production_steering") == [(1,)]
    trace = case.trace()
    assert sum(r["kind"] == "turn" for r in trace) == sum(r["kind"] == "steer" for r in trace) == 1
    assert next(r for r in trace if r["kind"] == "steer")["text_sha256"] == hashlib.sha256(request["text"].encode()).hexdigest()
    accept(case, 1)
    assert case.request(case.path + "/steer", "POST", request)[:2] == (200, receipt)
    assert delivery(case)["state"] == "acknowledged"
    assert rows(case, "SELECT count(*) FROM production_runs") == [(1,)]


def auth_and_scope(case):
    configure(case)
    case.start(configured=True)
    state = running(case)
    request = intent(state)
    for extra in [{"Origin": "https://foreign.invalid"}, {"x-orkestr-csrf": "bad"},
                  {"Cookie": ""}, {"Authorization": "Bearer " + case.machine}]:
        assert case.request(case.path + "/steer", "POST", request, True, extra)[0] in (401, 403)
    assert case.request(case.path + "/steer", "POST", request, False)[0] in (401, 403)
    assert case.request(case.path + "/steer", "POST", {**request, "native_turn_id": "foreign"})[0] == 400
    wrong = {**request, "control": {**request["control"], "run_id": str(uuid.uuid4())}}
    assert case.request(case.path + "/steer", "POST", wrong)[0] == 404
    assert case.request(f"/api/v2/conversations/{uuid.uuid4()}/steer", "POST", request)[0] == 404
    code, conversation, _ = case.request("/api/v2/projects", "POST", {
        "client_request_id": "unconfigured-scope", "name": "Unconfigured synthetic scope"})
    assert code == 201
    assert case.request(f"/api/v2/conversations/{conversation['conversation_id']}/steer", "POST", request)[0] == 503
    assert rows(case, "SELECT count(*) FROM production_steering") == [(0,)]
    assert not any(r["kind"] == "steer" for r in case.trace())
    submitted(case, request)
    wait_for(lambda: acknowledged(case), "valid same-scope request failed")


def ordered_input(case):
    configure(case)
    case.start(configured=True)
    state = running(case)
    assert case.message(2)[0] == 202
    assert case.phase("running")["capabilities"] == {"stop": True, "steer": False}
    request = intent(state)
    receipt = submitted(case, request, "queued_ordered")
    assert delivery(case)["state"] == "queued" and delivery(case)["written_bytes"] == 0
    assert case.request(case.path + "/steer", "POST", request)[:2] == (200, receipt)
    assert not any(r["kind"] == "steer" for r in case.trace())
    accept(case, 1)
    wait_for(lambda: len([r for r in case.trace() if r["kind"] == "turn"]) == 2, "older ordinary input was not next")
    assert [r["text"] for r in case.trace() if r["kind"] == "turn"][1] == "synthetic ordinary HTTP input 2"
    accept(case, 2)
    wait_for(lambda: len([r for r in case.trace() if r["kind"] == "turn"]) == 3, "queued steer was not preserved as ordinary input")
    assert [r["text"] for r in case.trace() if r["kind"] == "turn"][2] == request["text"]
    accept(case, 3)
    assert not any(r["kind"] == "steer" for r in case.trace())


def uncertain(case, mode):
    configure(case)
    (case.workspace / mode).touch()
    case.start(configured=True)
    state = running(case)
    request = intent(state)
    receipt = submitted(case, request)
    wait_for(lambda: any(r["kind"] == "steer" for r in case.trace()), "actual native steer bytes missing")
    wait_for(case.peer_gone, "uncertain steering must clean the owned native")
    # Broker cleanup reaps the native child before closing its own stdout.
    # Physical reaping is not a barrier for Rust's next EOF/Lost observation.
    # Measure the separate projection step, with a deadline rather than sleep.
    reaped_at = time.monotonic()
    observations = []
    case.steering_observations = {"control_projection_deadline_ms": 1000,
                                  "control_projection": observations}
    while True:
        code, status, _ = case.request(case.path + "/execution")
        elapsed = time.monotonic() - reaped_at
        assert code == 200, (code, status)
        observations.append({"elapsed_ms": round(elapsed * 1000, 3),
                             "phase": status["phase"], "capabilities": status["capabilities"]})
        assert elapsed <= 1, ("controls remained stale after native cleanup", observations)
        if status["capabilities"] == {"stop": False, "steer": False}:
            break
        time.sleep(0.005)
    value = delivery(case)
    assert value["state"] == "delivery_unknown" and value["written_bytes"] > 0
    assert case.request(case.path + "/steer", "POST", request)[:2] == (200, receipt)
    assert len([r for r in case.trace() if r["kind"] == "steer"]) == 1
    assert rows(case, "SELECT count(*) FROM production_runs") == [(1,)]
    assert rows(case, "SELECT count(*) FROM production_acceptances") == [(0,)]
    assert rows(case, "SELECT count(*) FROM reasoning_inbox WHERE state!='consumed'") == [(0,)]
    assert case.request(case.path + "/execution")[1]["capabilities"] == {"stop": False, "steer": False}


def stop_after_ack(case):
    configure(case)
    case.start(configured=True)
    state = running(case)
    submitted(case, intent(state))
    wait_for(lambda: acknowledged(case), "native acknowledgement missing before Stop")
    current = wait_for(lambda: available(case), "controls did not reopen after acknowledgement")
    request = {"run_id": current["run_id"], "expected_revision": current["revision"],
               "expected_control_revision": current["control_revision"], "request_key": "stop:after-steer"}
    assert case.request(case.path + "/stop", "POST", request)[0] == 200
    wait_for(lambda: case.phase("cancelled"), "native interrupted terminal missing")
    wait_for(case.peer_gone, "Stop did not reap the owned child")
    assert delivery(case)["state"] == "acknowledged"
    assert rows(case, "SELECT count(*) FROM production_acceptances") == [(0,)]


def revoke_browser_before_ack(case):
    configure(case)
    (case.workspace / "hold-steer-ack").touch()
    case.start(configured=True)
    state = running(case)
    request = intent(state)
    submitted(case, request)
    wait_for(lambda: any(r["kind"] == "steer" for r in case.trace()), "actual steer missing before revocation")
    assert case.request("/api/v2/browser/session", "DELETE")[0] == 204
    (case.workspace / "release-steer-ack").touch()
    wait_for(case.peer_gone, "revoked browser must fence native acknowledgement")
    assert case.request(case.path + "/steer", "POST", request)[0] == 401
    assert case.request(case.path + "/steering/steer:one")[0] == 401
    assert rows(case, "SELECT state FROM production_steering") == [("delivery_unknown",)]
    assert rows(case, "SELECT count(*) FROM production_acceptances") == [(0,)]


def renewal_preserves_steering(case):
    configure(case)
    case.start(configured=True)
    first = running(case)
    original = intent(first)
    original_receipt = submitted(case, original)
    wait_for(lambda: acknowledged(case), "initial steer acknowledgement missing")
    wait_for(lambda: rows(case, "SELECT lease_generation FROM production_runs")[0][0] > 1,
             "long work did not renew its existing native lease", 25)
    state = wait_for(lambda: available(case), "sealed issuer did not follow the renewed native fence")
    assert state["run_id"] == first["run_id"]
    request = intent(state, "steer:renewed")
    submitted(case, request)
    wait_for(lambda: acknowledged(case, "steer:renewed"), "renewed steer did not reach the same native turn")
    assert case.request(case.path + "/steer", "POST", original)[:2] == (200, original_receipt)
    trace = case.trace()
    assert sum(r["kind"] == "spawn" for r in trace) == sum(r["kind"] == "turn" for r in trace) == 1
    assert sum(r["kind"] == "steer" for r in trace) == 2
    assert rows(case, "SELECT count(*) FROM production_runs") == [(1,)]
    assert rows(case, "SELECT count(*) FROM production_acceptances") == [(0,)]
    accept(case, 1)


def lifetime_capacity_queues_honestly(case):
    configure(case)
    case.start(configured=True)
    running(case)
    for turn in (1, 2):
        if turn == 2:
            running(case, 2)
        for index in range(64):
            state = wait_for(lambda: available(case), "native capacity disappeared before its bound")
            key = f"steer:capacity:{turn}:{index}"
            submitted(case, intent(state, key))
            wait_for(lambda: acknowledged(case, key), "bounded steer acknowledgement missing")
        if turn == 1:
            accept(case, 1)
    state = case.phase("running")
    assert state["capabilities"] == {"stop": True, "steer": False}
    request = intent(state)
    submitted(case, request, "queued_unsupported")
    assert delivery(case)["state"] == "queued" and delivery(case)["written_bytes"] == 0
    accept(case, 2)
    wait_for(lambda: len([r for r in case.trace() if r["kind"] == "turn"]) == 3, "unsupported steer input lost")
    assert [r["text"] for r in case.trace() if r["kind"] == "turn"][2] == request["text"]
    accept(case, 3)
    assert sum(r["kind"] == "steer" for r in case.trace()) == 128
    assert sum(r["kind"] == "spawn" for r in case.trace()) == 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    results = []
    cases = [success_and_replay, auth_and_scope, ordered_input,
             lambda c: uncertain(c, "missing-steer-ack"), lambda c: uncertain(c, "wrong-turn-ack"),
             stop_after_ack, revoke_browser_before_ack, renewal_preserves_steering,
             lifetime_capacity_queues_honestly]
    names = ["success_and_replay", "auth_and_scope", "ordered_input", "missing_ack_unknown", "foreign_ack_unknown",
             "stop_after_ack", "revoke_browser_before_ack", "renewal_preserves_steering",
             "lifetime_capacity_queues_honestly"]
    for name, operation in zip(names, cases):
        case = Case()
        started = time.monotonic()
        result = {"name": name, "passed": False}
        results.append(result)
        try:
            case.setup()
            operation(case)
            result["passed"] = True
            print("ordinary synthetic steering HTTP case passed:", name, flush=True)
        except Exception as error:
            result["failure"] = {"type": type(error).__name__, "detail": str(error)}
            raise
        finally:
            result["seconds"] = round(time.monotonic()-started, 3)
            if hasattr(case, "steering_observations"):
                result["observations"] = case.steering_observations
            case.cleanup()
            if args.report:
                args.report.write_text(json.dumps({"cases": results, "synthetic_native": True}, indent=2) + "\n")


if __name__ == "__main__":
    main()
