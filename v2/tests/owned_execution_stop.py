"""Browser Stop to a fixed native peer, including acknowledgement-only refusal."""
import sqlite3


def stop(case, wait_for, terminal):
    case.stop()
    case.configure()
    (case.workspace / "stop-mode").write_text("terminal" if terminal else "ack-only")
    case.start(configured=True)
    assert case.message()[0] == 202

    def available():
        status = case.phase("running")
        return status if status and status["capabilities"]["stop"] else None
    running = wait_for(available, "owned running turn must expose live Stop capability")
    assert not running["capabilities"]["steer"]
    body = {"run_id": running["run_id"], "expected_revision": running["revision"],
            "request_key": "synthetic-http-stop"}
    # All rejection checks occur before any cancellation intent or provider I/O.
    assert case.request(case.path + "/stop", "POST", body,
                        extra={"x-orkestr-csrf": "wrong"})[0] == 403
    assert case.request(case.path + "/stop", "POST", body,
                        extra={"Origin": "https://foreign.invalid"})[0] == 403
    assert case.request(case.path + "/stop", "POST",
                        {**body, "provider_auth": "synthetic-forbidden-authority"})[0] == 400
    stale = {**body, "expected_revision": max(0, running["revision"] - 1)}
    assert case.request(case.path + "/stop", "POST", stale)[0] == 409
    assert not any(row["kind"] == "interrupt" for row in case.trace())
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 0
    assert case.message(2)[0] == 202
    # Intake and provider progress can advance the snapshot independently. Keep
    # the legacy stale-snapshot refusal above; the valid request uses the exact
    # run's stable control precondition, as the ordinary browser does.
    running = wait_for(available, "owned Stop remains available after queued intake")
    body["expected_revision"] = running["revision"]
    body["expected_control_revision"] = running["control_revision"]
    code, receipt, headers = case.request(case.path + "/stop", "POST", body)
    assert code == 200 and receipt["outcome"] == "requested_unknown", (code, receipt)
    assert "no-store" in headers["Cache-Control"]
    # The second issued Core receipt remains server-private.
    assert set(receipt) == {"schema_version", "conversation_id", "run_id", "request_key",
                            "requested_revision", "revision", "outcome"}
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    wait_for(lambda: any(row["kind"] == "interrupt-ack" for row in case.trace()),
             "actual native interrupt acknowledgement")
    pending = case.phase("cancel_requested")
    assert pending and not pending["capabilities"]["stop"]
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='stopped'").fetchone()[0] == 0
    if terminal:
        (case.workspace / "release-stop").touch()
        final = wait_for(lambda: case.phase("cancelled"), "only terminal provider evidence confirms Stop")
        assert not final["capabilities"]["stop"]
    wait_for(case.peer_gone, "owned native child must disappear after Stop or bounded reconciliation")
    if not terminal:
        assert case.phase("cancel_requested"), "ACK-only timeout must remain unresolved"
    assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    trace = case.trace()
    assert sum(row["kind"] == "turn" for row in trace) == 1
    assert sum(row["kind"] == "interrupt" for row in trace) == 1
    assert len({row["pid"] for row in trace}) == 1
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM reasoning_inbox WHERE state!='consumed'").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='stopped'").fetchone()[0] == int(terminal)
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='completed_proposal'").fetchone()[0] == 0
        expected = "acknowledged" if terminal else "pending"
        assert db.execute("SELECT state FROM production_control_outbox").fetchone()[0] == expected
