"""Real-HTTP owner auto-accept: Deep, its Worker and Fast accepted by the server.

One window turn whose Deep delegates a Worker. Every proposal is held until
the owner's browser session has been revoked; from then on the fixture sends
no request at all and reads Core read-only. The server's system principal
must accept the Worker, Fast and Deep proposals itself (no manual accept, no
browser or adapter session), audited with actor `auto_accept`.

A restart before the proposals complete is not part of this scenario: a
window whose process is gone is reconciled (abandoned), never accepted.

Run as root with a server built from the same source, like service_roles_http.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

from owned_execution_http import wait_for
from service_roles_case import ServiceRolesCase
from service_roles_http import expect, intake, path, ready, window_request


def run(case):
    first = case.conversation
    # Auto-accept is the default: no settings are written.
    for role in ("deep", "fast", "worker-0"):
        case.fixture.write_private(case.workspaces[role] / "mode", b"hold")
    key = "auto:1"
    expect(case, path(first) + "/window", 201, "POST", window_request(intake(case, first, key, 1), key))
    deep = ready(case, first, "deep", "running")
    tasks = path(first) + "/worker-tasks?parent_run_id=" + deep["run_id"]
    wait_for(lambda: expect(case, tasks)["can_create"], "owned Worker task scheduler")
    exact = ready(case, first, "deep", "running", run=deep["run_id"])
    task = expect(case, path(first) + "/worker-tasks", 200, "POST",
                  {"parent_run_id": deep["run_id"], "expected_control_revision": exact["control_revision"],
                   "request_key": "auto:worker", "title": "Synthetic auto-accepted Worker",
                   "instructions": "synthetic ordinary HTTP input 41", "lifetime_ms": 30000})

    def task_row():
        found = [row for row in expect(case, tasks)["tasks"] if row["task"]["task_id"] == task["task_id"]]
        assert len(found) == 1
        return found[0]
    wait_for(lambda: task_row()["phase"] == "running", "live Worker", 20)
    assert case.rows("SELECT count(*) AS n FROM production_runs WHERE state='awaiting_acceptance'") == [{"n": 0}]

    # Revoke the only browser session. No HTTP request follows.
    expect(case, "/api/v2/browser/session", 204, "DELETE")
    code, _, _ = case.request(path(first) + "/execution")
    assert code in (401, 403), code
    case.cookie = case.csrf = None
    for role, release in (("worker-0", "release-41"), ("fast", "release-1"), ("deep", "release-1")):
        (case.workspaces[role] / release).touch()

    def settled():
        runs = case.rows("SELECT id,role,state FROM production_runs ORDER BY rowid")
        return runs if len(runs) == 3 and all(row["state"] == "succeeded" for row in runs) else None
    runs = wait_for(settled, "server auto-accepted Worker, Fast and Deep", 60)
    assert sorted(row["role"] for row in runs) == ["deep", "fast", "worker"], runs
    accepted = case.rows(
        "SELECT a.run_id,a.request_key,r.role,e.sequence,auto.actor,auto.window_id FROM production_acceptances a "
        "JOIN production_runs r ON r.id=a.run_id JOIN events e ON e.id=a.event_id "
        "LEFT JOIN production_auto_acceptances auto ON auto.run_id=a.run_id ORDER BY e.sequence")
    assert len(accepted) == 3, accepted
    for row in accepted:
        assert row["actor"] == "auto_accept" and row["window_id"], row
        assert row["request_key"] == "auto-accept:" + row["run_id"], row
    order = [row["role"] for row in accepted]
    assert order.index("worker") < order.index("deep"), order
    windows = case.rows("SELECT id,conversation_id,state FROM execution_windows")
    assert len(windows) == 1 and windows[0]["conversation_id"] == first
    assert {row["window_id"] for row in accepted} == {windows[0]["id"]}
    case.stop()
    return {"runs": runs, "acceptances": [dict(row) for row in accepted], "trace": case.trace()}


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
            record["cleanup"] = {"originals_gone": True, "forced": case.forced}
        except BaseException as error:
            record["passed"] = False
            record["cleanup_error"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            record["elapsed_seconds"] = round(time.monotonic() - started, 3)
            with args.report.open("x") as stream:
                args.report.chmod(0o600)
                json.dump(record, stream, indent=2, default=str)
                stream.write("\n")
            print(json.dumps({key: record[key] for key in ("fixture", "passed", "elapsed_seconds")}), flush=True)
