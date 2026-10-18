"""Actual Worker HTTP Stop and exact replay against disposable synthetic peers.

The product has one owner per installation. Foreign-owner coverage uses a real
browser session from a second disposable installation; registry unit tests
separately reject a different owner within the exact registered scope.
"""
import json
import socket
import uuid

import worker_execution_http as worker

ordinary = worker.ordinary


def exact_status(case, run_id):
    code, status, _ = case.request(case.path + "/execution?run_id=" + run_id)
    assert code == 200 and status["run_id"] == run_id
    return status


def ready(case):
    child = ordinary.wait_for(lambda: case.role_state("worker", "running"),
                              "independent Worker did not start")
    parent = case.role_state("deep", "running")
    assert parent is not None

    def available():
        status = exact_status(case, child["id"])
        return status if status["capabilities"]["stop"] else None
    status = ordinary.wait_for(available, "Worker must expose its own live Stop capability")
    assert isinstance(status["control_revision"], int) and status["control_revision"] > 0
    assert status["phase"] == "running"
    return child, parent, status


def intent(status, key):
    return {"run_id": status["run_id"], "expected_revision": status["revision"],
            "expected_control_revision": status["control_revision"], "request_key": key}


def cancellation_rows(case):
    return case.rows("SELECT run_id,request_key FROM production_cancellations ORDER BY run_id")


def assert_one_child_interrupt(case, child):
    interrupts = [row for row in case.trace() if row["kind"] == "interrupt"]
    assert len(interrupts) == 1 and interrupts[0]["role"] == "worker"
    assert interrupts[0]["native"] == child["native_session_id"]


def assert_child_cancelled(case, child, parent, before):
    ordinary.wait_for(lambda: case.role_state("worker", "cancelled"),
                      "Worker Stop needs correlated native interrupted terminal evidence")
    ordinary.wait_for(case.worker_gone, "Worker Stop did not reap its child and scratch")
    assert case.role_state("deep", "running")["id"] == parent["id"]
    assert case.inbox() == before
    assert case.rows("SELECT run_id FROM production_observations WHERE kind='stopped'") == [
        {"run_id": child["id"]}]
    assert_one_child_interrupt(case, child)


def finish_parent(case, parent):
    (case.workspace / "release-deep").touch()
    ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "unaffected parent completion missing")
    assert case.accept(parent["id"], case.completion(parent["id"]), "parent-after-child-stop")[0] == 200


def worker_http_stop_scope_and_streaming(case):
    worker.start(case, hold_worker=True)
    child, parent, status = ready(case)
    body = intent(status, "synthetic-worker-http-stop")
    before = case.inbox()
    original_cancellations = cancellation_rows(case)
    assert not original_cancellations
    wrong = dict(body, run_id=str(uuid.uuid4()))
    assert case.request(case.path + "/stop", "POST", wrong)[0] == 503
    wrong = dict(body, expected_control_revision=body["expected_control_revision"] + 1)
    assert case.request(case.path + "/stop", "POST", wrong)[0] == 409
    assert case.request(case.path + "/stop", "POST", body, extra={"x-orkestr-csrf": "wrong"})[0] == 403
    assert case.request(case.path + "/stop", "POST", dict(body, provider_auth="forbidden"))[0] == 422
    foreign = ordinary.Case()
    try:
        foreign.setup()
        assert case.request(case.path + "/stop", "POST", body,
                            extra={"Cookie": foreign.cookie, "x-orkestr-csrf": foreign.csrf})[0] == 401
        assert case.request(case.path + "/execution?run_id=" + child["id"],
                            extra={"Cookie": foreign.cookie, "x-orkestr-csrf": foreign.csrf})[0] == 401
    finally:
        foreign.cleanup()
    assert cancellation_rows(case) == original_cancellations
    assert not [row for row in case.trace() if row["kind"] == "interrupt"]

    # Deliberately make the global projection stale with both parent and child
    # progress. Keep the original exact run-control revision and request tuple.
    (case.workspace / "progress-after-status").touch()
    ordinary.wait_for(lambda: len([row for row in case.trace() if row["kind"] == "extra-progress"]) == 2,
                      "both independent peers must emit progress after status")
    def progress_applied():
        found = {}
        for run in (parent, child):
            current = exact_status(case, run["id"])
            if not current["progress"]:
                return None
            code, payload, _ = case.request(case.path + "/payloads/" + current["progress"]["payload_id"])
            assert code == 200
            if "progress after control status" not in (payload["text"] or ""):
                return None
            found[run["id"]] = current
        return found[child["id"]]
    fresh = ordinary.wait_for(progress_applied, "both progress updates must persist before Stop")
    assert fresh["revision"] > status["revision"]
    assert fresh["control_revision"] == status["control_revision"]
    code, receipt, _ = case.request(case.path + "/stop", "POST", body)
    assert code == 200 and receipt["run_id"] == child["id"]
    assert_child_cancelled(case, child, parent, before)
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    assert case.request(case.path + "/stop", "POST", dict(body, expected_control_revision=None))[0] == 503
    assert_one_child_interrupt(case, child)
    finish_parent(case, parent)


def worker_http_stop_dropped_response(case):
    worker.start(case, hold_worker=True)
    child, parent, status = ready(case)
    body = intent(status, "synthetic-worker-lost-response")
    before = case.inbox()
    raw = json.dumps(body).encode()
    # Case.start already proved this exact child owns this loopback listener.
    # Discard the first response only after observing durable cancellation.
    headers = (f"POST {case.path}/stop HTTP/1.1\r\nHost: 127.0.0.1:{case.port}\r\n"
               f"Origin: {case.origin}\r\nCookie: {case.cookie}\r\n"
               f"x-orkestr-csrf: {case.csrf}\r\nContent-Type: application/json\r\n"
               f"Content-Length: {len(raw)}\r\nConnection: close\r\n\r\n").encode()
    with socket.create_connection(("127.0.0.1", case.port), timeout=3) as stream:
        stream.sendall(headers + raw)
        ordinary.wait_for(lambda: cancellation_rows(case), "lost-response Stop was not committed")
    assert_child_cancelled(case, child, parent, before)
    code, receipt, _ = case.request(case.path + "/stop", "POST", body)
    assert code == 200 and receipt["run_id"] == child["id"]
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    assert len(cancellation_rows(case)) == 1
    assert_one_child_interrupt(case, child)
    finish_parent(case, parent)


def worker_http_stop_ack_only_unknown(case):
    (case.workspace / "worker-ack-only").touch()
    worker.start(case, hold_worker=True)
    child, parent, status = ready(case)
    before = case.inbox()
    body = intent(status, "synthetic-worker-ack-only")
    code, receipt, _ = case.request(case.path + "/stop", "POST", body)
    assert code == 200 and receipt["outcome"] == "requested_unknown"
    ordinary.wait_for(case.worker_gone, "ACK-only Worker must receive bounded owned cleanup")
    assert case.role_state("worker", "cancel_requested")["id"] == child["id"]
    assert case.role_state("deep", "running")["id"] == parent["id"]
    assert not case.rows("SELECT run_id FROM production_observations WHERE kind='stopped'")
    assert case.inbox() == before
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    assert len(cancellation_rows(case)) == 1
    assert_one_child_interrupt(case, child)


def worker_http_stop_after_late_progress(case):
    (case.workspace / "worker-late-progress").touch()
    worker.start(case, hold_worker=True)
    child, parent, status = ready(case)
    before = case.inbox()
    body = intent(status, "synthetic-worker-late-progress")
    assert case.request(case.path + "/stop", "POST", body)[0] == 200
    assert_child_cancelled(case, child, parent, before)
    assert [row["count"] for row in case.trace() if row["kind"] == "late-progress"] == [32]
    finish_parent(case, parent)


if __name__ == "__main__":
    worker.SCENARIOS = [worker_http_stop_scope_and_streaming, worker_http_stop_dropped_response,
                        worker_http_stop_ack_only_unknown, worker_http_stop_after_late_progress]
    worker.main()
