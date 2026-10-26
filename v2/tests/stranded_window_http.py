"""Real-HTTP restart with a window stranded by unaccepted Fast and Deep proposals.

Reproduces the pilot shape: a window's proposals await acceptance when the
service stops. The stop must be CLEAN (every original child reaped; the window
is durably left for reconciliation, not retired). The hard deadline passes
while it is down and another conversation holds a saved input. After a restart
the first owner request reconciles the stranded window (audited abandonment,
no acceptance, no re-execution), the other conversation opens, and the
abandoned conversation resumes Deep and starts Fast fresh in a successor window.

Run as root with a server built from the same source, like service_roles_http.
"""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import time

from owned_execution_http import wait_for
from service_roles_case import ServiceRolesCase
from service_roles_http import accept, expect, intake, path, ready, review, window_request, windows


def restart(case):
    f = case.fixture
    case.spawn([str(f.package / "manager.py"), case.receipt["manifest_sha256"]],
               {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, label="manager-restarted")
    wait_for(lambda: case.listener(f.package / "server"), "restarted configured listener", 15)
    assert case.request("/api/v2/health", browser=False)[0] == 200


def expire_while_stopped(case, window):
    # The hard deadline passes while the service is down. Core timestamps keep
    # their fixed 870/900 s shape; nothing else in Core or the manager changes.
    # Past the hard deadline and the 24 h acceptance grace, so the automatic
    # path may abandon proposals still awaiting the owner.
    shift = 900001 + 86400000
    with closing(sqlite3.connect(case.home / "core.sqlite3")) as db:
        db.execute("UPDATE execution_windows SET opened_at_ms=opened_at_ms-?,"
                   "work_deadline_ms=work_deadline_ms-?,expires_at_ms=expires_at_ms-? "
                   "WHERE id=?", (shift, shift, shift, window))
        db.commit()


def turns(case):
    return [row for row in case.trace() if row["kind"] == "turn"]


def run(case):
    first = case.conversation
    second = expect(case, "/api/v2/conversations", 201, "POST",
                    {"client_request_id": "synthetic:stranded-second",
                     "name": "Synthetic stranded second"})["conversation_id"]
    # Proposals must stay unaccepted across the stop: no owner auto-accept.
    review(case, first)
    review(case, second)
    case.fixture.write_private(case.workspaces["deep"] / "mode", b"complete")
    key = "first:1"
    a = expect(case, path(first) + "/window", 201, "POST",
               window_request(intake(case, first, key, 1), key))["status"]
    deep, fast = ready(case, first, "deep"), ready(case, first, "fast")
    fast["_role"] = "fast"
    before = turns(case)
    assert len(before) == 2
    bkey = "second:1"
    saved = window_request(intake(case, second, bkey, 2), bkey)

    # Clean stop although the window cannot be retired: custody is released
    # (every original child reaped) and the window is left for reconciliation.
    case.stop()
    manager_before = case.rows("SELECT state,reason FROM windows WHERE id=?", (a["window_id"],), manager=True)
    assert manager_before[0]["state"] == "reconciliation", manager_before
    stranded = next(row for row in windows(case) if row["id"] == a["window_id"])
    assert stranded["state"] != "closed"
    expire_while_stopped(case, a["window_id"])
    restart(case)

    # First owner request after restart reconciles the stranded window
    # automatically; the saved input of the other conversation opens.
    b = expect(case, path(second) + "/window", 201, "POST", saved)["status"]
    assert b["generation"] == 1 and b["conversation_id"] == second
    closed = next(row for row in windows(case) if row["id"] == a["window_id"])
    assert closed["state"] == "closed" and closed["terminal_run_id"] == deep["run_id"]
    audit = case.rows("SELECT actor,decision,outcome,prior_run_id,hard_deadline_passed "
                      "FROM execution_window_reconciliations")
    assert audit == [{"actor": "startup", "decision": "abandon_unaccepted", "outcome": "abandoned",
                      "prior_run_id": deep["run_id"], "hard_deadline_passed": 1}], audit
    abandoned = case.rows("SELECT a.run_id,r.state,t.terminal_kind FROM production_run_abandonments a "
                          "JOIN production_runs r ON r.id=a.run_id "
                          "JOIN production_terminal_evidence t ON t.run_id=r.id ORDER BY a.run_id")
    assert {row["run_id"] for row in abandoned} == {deep["run_id"], fast["run_id"]}
    assert all(row["state"] == "cancelled" and row["terminal_kind"] == "abandoned" for row in abandoned)
    manager = case.rows("SELECT id,state,outcome,run_id,reason FROM windows WHERE id=?",
                        (a["window_id"],), manager=True)
    assert manager[0]["state"] == "retired" and manager[0]["outcome"] == "abandoned", manager
    assert manager[0]["run_id"] == deep["run_id"]

    # Owner endpoint replays the committed decision; late acceptance refuses.
    replay = expect(case, path(first) + "/window/reconcile", 200, "POST",
                    {"window_id": a["window_id"], "generation": 1, "decision": "abandon_unaccepted"})
    assert replay["duplicate"] and replay["outcome"] == "abandoned"
    for projection in (deep, fast):
        code, value, _ = case.request(path(first) + "/accept", "POST",
            {**projection["acceptance_candidate"], "expected_revision": projection["revision"],
             "request_key": "late:" + projection["run_id"]})
        assert code in (404, 409), (code, value)
    assert case.rows("SELECT count(*) AS n FROM production_acceptances") == [{"n": 0}]

    bdeep, bfast = ready(case, second, "deep"), ready(case, second, "fast")
    bfast["_role"] = "fast"
    accept(case, second, bdeep, "accept:second-deep")
    accept(case, second, bfast, "accept:second-fast")
    # The abandoned conversation resumes Deep and starts Fast with bounded history.
    akey = "first:2"
    resumed = expect(case, path(first) + "/window", 201, "POST",
                     window_request(intake(case, first, akey, 3), akey, 1, a["window_id"]))["status"]
    assert resumed["generation"] == 2 and resumed["predecessor_window_id"] == a["window_id"]
    adeep = ready(case, first, "deep", previous=deep["run_id"])
    afast = ready(case, first, "fast", previous=fast["run_id"])
    afast["_role"] = "fast"
    accept(case, first, afast, "accept:first-resumed-fast")
    accept(case, first, adeep, "accept:first-resumed-deep")
    after = turns(case)
    # Exactly: 2 original + 2 second conversation + 2 resumed; nothing re-run.
    assert len(after) == 6, after
    runs = case.rows("SELECT id,role,conversation_id,state,native_session_id FROM production_runs ORDER BY rowid")
    assert len(runs) == 6
    for role in ("deep", "fast"):
        mine = [row for row in runs if row["role"] == role and row["conversation_id"] == first]
        identities = 2 if role == "fast" else 1
        assert len(mine) == 2 and len({row["native_session_id"] for row in mine}) == identities
    case.stop()
    final = windows(case)
    assert len(final) == 3 and all(row["state"] == "closed" for row in final)
    ledger = case.rows("SELECT state,outcome FROM windows ORDER BY rowid", manager=True)
    assert [row["outcome"] for row in ledger] == ["abandoned", "accepted", "accepted"], ledger
    return {"windows": final, "manager": ledger, "audit": audit, "runs": runs}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    record = {"source": args.source, "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              "actual_provider": False, "passed": False}
    case = ServiceRolesCase(args.source)
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
        except BaseException as error:
            record["passed"] = False
            record["cleanup_error"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            record["elapsed_seconds"] = round(time.monotonic() - started, 3)
            with args.report.open("x") as stream:
                args.report.chmod(0o600)
                json.dump(record, stream, indent=2)
                stream.write("\n")
            print(json.dumps({key: record[key] for key in ("passed", "elapsed_seconds")}), flush=True)
