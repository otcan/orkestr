"""Ordinary HTTP Stop across a deterministic native progress interleaving."""
import sqlite3
import uuid


def streaming_stop(case, wait_for, late_burst=False):
    case.stop()
    case.configure()
    (case.workspace / "stop-mode").write_text("terminal")
    (case.workspace / "hold-before-stop").touch()
    if late_burst:
        (case.workspace / "late-stop-progress").touch()
    case.start(configured=True)
    assert case.message()[0] == 202

    def available():
        status = case.phase("running")
        return status if status and status["capabilities"]["stop"] and status.get("progress") else None

    before = wait_for(available, "initial native progress and live Stop capability")
    exact_path = case.path + "/execution?run_id=" + before["run_id"]
    code, exact, headers = case.request(exact_path)
    assert code == 200 and "no-store" in headers["Cache-Control"]
    assert exact["run_id"] == before["run_id"] and exact["control_revision"] == before["control_revision"]
    assert case.request(exact_path, browser=False)[0] == 401
    for query in ["run_id=invalid", "run_id=" + str(uuid.UUID(int=0)),
                  "run_id=" + before["run_id"] + "&run_id=" + before["run_id"],
                  "run_id=" + before["run_id"] + "&provider_auth=forbidden"]:
        assert case.request(case.path + "/execution?" + query)[0] == 400
    assert case.request(case.path + "/execution?run_id=" + str(uuid.uuid4()))[0] == 404
    control_revision = before["control_revision"]
    assert control_revision > 1, "Started must advance the exact run control revision"
    body = {"run_id": before["run_id"], "expected_revision": before["revision"],
            "expected_control_revision": control_revision, "request_key": "streaming-stop"}
    # The peer cannot emit this frame until AFTER the browser has sampled status.
    # Wait for its actual persisted payload; a sleep is not proof of interleaving.
    (case.workspace / "release-progress").touch()

    def interleaved():
        status = available()
        if not status or status["revision"] <= before["revision"]:
            return None
        assert status["run_id"] == before["run_id"]
        assert status["control_revision"] == control_revision
        code, payload, _ = case.request(case.path + "/payloads/" + status["progress"]["payload_id"])
        return status if code == 200 and payload["text"] == "synthetic interleaved progress" else None

    after = wait_for(interleaved, "native progress must commit between status GET and Stop POST")
    # A genuinely old control version still refuses before any durable intent.
    stale = {**body, "expected_control_revision": control_revision - 1}
    assert case.request(case.path + "/stop", "POST", stale)[0] == 409
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 0
    assert not any(row["kind"] == "interrupt" for row in case.trace())

    # Exactly one valid attempt uses the original projection revision. There is
    # no refresh/retry loop masking a conflict under a continuously active stream.
    code, receipt, _ = case.request(case.path + "/stop", "POST", body)
    assert code == 200 and receipt["outcome"] == "requested_unknown"
    assert receipt["requested_revision"] == before["revision"]
    assert receipt["revision"] > after["revision"]
    wait_for(lambda: any(row["kind"] == "interrupt-ack" for row in case.trace()),
             "native Stop ACK must arrive through the actual owned stdin")
    assert case.phase("cancel_requested"), "ACK alone must never confirm Stop"
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='stopped'").fetchone()[0] == 0
    (case.workspace / "release-stop").touch()
    wait_for(lambda: case.phase("cancelled"), "native terminal must confirm Stop after valid late progress")
    wait_for(case.peer_gone, "confirmed Stop must reap the same owned native peer")
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    # Registry replay is exact, including the additional control precondition.
    assert case.request(case.path + "/stop", "POST", stale)[0] == 503
    assert sum(row["kind"] == "interrupt" for row in case.trace()) == 1
    assert len({row["pid"] for row in case.trace()}) == 1
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='stopped'").fetchone()[0] == 1
        assert db.execute("SELECT state FROM production_control_outbox").fetchone()[0] == "acknowledged"
