"""Ordinary HTTP follow-ups against the fixed synthetic native executable."""
import sqlite3


def proposal(case, wait_for, previous=None):
    def current():
        status = case.phase("awaiting_acceptance")
        return status if status and status["run_id"] != previous else None
    return wait_for(current, "next durable completion proposal")


def accept(case, status, number):
    candidate = status["acceptance_candidate"]
    assert candidate["run_id"] == status["run_id"]
    body = {**candidate, "expected_revision": status["revision"],
            "request_key": f"followup-accept:{number}"}
    code, receipt, _ = case.request(case.path + "/accept", "POST", body)
    assert code == 200 and receipt["outcome"] == "succeeded"
    assert case.request(case.path + "/accept", "POST", body)[:2] == (200, receipt)


def turns(case, count):
    trace = case.trace()
    assert len([row for row in trace if row["kind"] == "spawn"]) == 1
    assert len([row for row in trace if row["kind"] == "ready"]) == 1
    assert len([row for row in trace if row["kind"] == "turn"]) == count
    assert len({row["pid"] for row in trace}) == 1


def ledger(case, total, queued):
    # Only this test's fresh disposable database; no private host state.
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == total
        assert db.execute("SELECT count(*) FROM reasoning_inbox WHERE state!='consumed'").fetchone()[0] == queued
        assert db.execute("SELECT count(DISTINCT session_id) FROM production_runs").fetchone()[0] == 1
        assert db.execute("SELECT count(DISTINCT native_session_id) FROM production_runs").fetchone()[0] == 1
        assert db.execute("SELECT count(DISTINCT message_id) FROM production_runs").fetchone()[0] == total


def two_turn(case, wait_for):
    case.stop()
    case.configure()
    case.start(configured=True)
    assert case.message()[0] == 202
    first = proposal(case, wait_for)
    assert not case.peer_gone(), "completion must retain the same native child"
    accept(case, first, 1)
    intake = case.message(2)
    assert intake[0] == 202
    second = proposal(case, wait_for, first["run_id"])
    accept(case, second, 2)
    turns(case, 2)
    ledger(case, 2, 0)
    # Client receipt replay must not acquire/consume another run grant.
    assert case.message(2)[:2] == (200, intake[1])
    turns(case, 2)
    ledger(case, 2, 0)
    assert not case.peer_gone()


def in_flight_followup(case, wait_for):
    case.stop()
    case.configure()
    (case.workspace / "hold-first").touch()
    case.start(configured=True)
    assert case.message()[0] == 202
    wait_for(lambda: case.phase("running"), "first synthetic turn must be active")
    intake = case.message(2)
    assert intake[0] == 202
    assert case.message(3)[0] == 202
    assert case.message(2)[:2] == (200, intake[1])
    status = case.phase("running")
    assert status and status["queue_age_ms"] is not None
    assert not status["capabilities"]["steer"], "ordered fallback must not claim steer"
    turns(case, 1)
    ledger(case, 1, 2)
    (case.workspace / "release-first").touch()
    first = proposal(case, wait_for)
    turns(case, 1)
    ledger(case, 1, 2)
    assert not case.peer_gone()
    accept(case, first, 1)
    second = proposal(case, wait_for, first["run_id"])
    turns(case, 2)
    ledger(case, 2, 1)
    accept(case, second, 2)
    third = proposal(case, wait_for, second["run_id"])
    accept(case, third, 3)
    turns(case, 3)
    ledger(case, 3, 0)
    assert not case.peer_gone()
