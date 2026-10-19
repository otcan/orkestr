"""Ordinary HTTP budgets and natural lease passage, fixed synthetic peer only."""
import json
import sqlite3
import sys
import time

from owned_execution_http import Case, wait_for


def configure(case, policy):
    case.setup()
    case.stop()
    case.configure()
    path = case.root / "execution.json"
    config = json.loads(path.read_text())
    config["execution_budget"] = policy
    path.write_text(json.dumps(config))
    (case.workspace / "stop-mode").write_text("terminal")
    (case.workspace / "release-stop").touch()
    case.start(configured=True)
    assert case.message()[0] == 202
    return wait_for(lambda: case.phase("running"), "synthetic run must start")


def terminal(case, key):
    status = wait_for(lambda: case.phase("cancelled"), "budget must use actual terminal Stop")
    assert not status["capabilities"]["stop"]
    wait_for(case.peer_gone, "budget cleanup must reap the original native host identity")
    trace = case.trace()
    assert sum(row["kind"] == "spawn" for row in trace) == 1
    assert sum(row["kind"] == "turn" for row in trace) == 1
    assert sum(row["kind"] == "interrupt" for row in trace) == 1
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT request_key FROM production_cancellations").fetchall() == [(key,)]
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='stopped'").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == 1


def short_budget(policy, key):
    case = Case()
    try:
        configure(case, policy)
        assert case.message(2)[0] == 202
        terminal(case, key)
        code, page, _ = case.request(case.path + "/held-inputs")
        assert code == 200 and len(page["held"]) == 1
        assert page["held"][0]["reason"] == "stop_boundary"
        assert not page["eligible_input_available"]
    finally:
        case.cleanup()


def natural_lease_renewal():
    case = Case()
    try:
        original = configure(case, {"max_run_ms": 120_000})
        started = time.monotonic()
        # No clock overrides or database writes. Keep the actual native idle
        # beyond its original durable lease, then Stop the original exact run.
        while time.monotonic() - started < 65:
            status = case.phase("running")
            assert status and status["run_id"] == original["run_id"]
            assert status["control_revision"] == original["control_revision"]
            assert not case.peer_gone()
            time.sleep(0.5)
        with sqlite3.connect(case.home / "core.sqlite3") as db:
            generations = db.execute("SELECT generation FROM production_run_leases WHERE purpose='execution' ORDER BY generation").fetchall()
            assert len(generations) >= 2 and generations[0] == (1,)
            assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 0
        body = {"run_id": original["run_id"], "expected_revision": original["revision"],
                "expected_control_revision": original["control_revision"],
                "request_key": "synthetic-stop-after-natural-renewal"}
        code, receipt, _ = case.request(case.path + "/stop", "POST", body)
        assert code == 200 and receipt["outcome"] == "requested_unknown"
        terminal(case, body["request_key"])
        assert case.request(case.path + "/stop", "POST", body)[:2] == (200, receipt)
    finally:
        case.cleanup()


def revoked_after_renewal():
    case = Case()
    try:
        original = configure(case, {"max_run_ms": 120_000})
        def renewed():
            with sqlite3.connect(case.home / "core.sqlite3") as db:
                return db.execute("SELECT count(*) FROM production_run_leases WHERE purpose='execution'").fetchone()[0] >= 2
        wait_for(renewed, "same-child lease must renew before auth revocation", seconds=30)
        assert case.phase("running")["run_id"] == original["run_id"]
        case.revoke_machine()
        wait_for(case.peer_gone, "revoked machine must reap the renewed child")
        wait_for(lambda: not case.request(case.path + "/execution")[1]["capabilities"]["stop"],
                 "retired renewed child must close local control availability")
        with sqlite3.connect(case.home / "core.sqlite3") as db:
            assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == 1
            assert db.execute("SELECT count(*) FROM production_observations WHERE kind IN ('stopped','completed_proposal')").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 0
            assert db.execute("SELECT state FROM production_runs").fetchone()[0] not in ("cancelled", "succeeded")
        assert sum(row["kind"] == "spawn" for row in case.trace()) == 1
        assert sum(row["kind"] == "turn" for row in case.trace()) == 1
        assert not any(row["kind"] == "interrupt" for row in case.trace())
    finally:
        case.cleanup()


if __name__ == "__main__":
    if "--long-only" in sys.argv:
        natural_lease_renewal()
        print("case passed: natural_lease_renewal", flush=True)
    elif "--revoked-only" in sys.argv:
        revoked_after_renewal()
        print("case passed: revoked_after_renewal", flush=True)
    else:
        for policy, key in [
            ({"max_run_ms": 2_000}, "execution-run-budget-expired"),
            ({"max_run_ms": 10_000, "max_idle_ms": 1_500}, "execution-idle-budget-expired"),
        ]:
            short_budget(policy, key)
            print("case passed: " + key, flush=True)
