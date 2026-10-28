"""Real-HTTP read-only parallel Deep slots (docs/v2/parallel-deep.md).

One window with the owner's `parallel_deep` switch on and auto-accept (the
default). While the writer's Deep turn for input 1 is held, inputs 2 and 3
are answered by read-only parallel Deep slots on the Fast service profile,
accepted by the server and retired; the writer never answers them. Then the
writer's next turn carries a note of those answers, a further input gets a
slot, and the owner's Stop of the writer stops that slot too. With the
switch off (second conversation) a burst is answered by the writer alone.

Run as root with a server built from the same source, like service_roles_http.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

from owned_execution_http import wait_for
from service_roles_case import ServiceRolesCase
from service_roles_http import accept, expect, intake, path, ready, status, window_request


def switch(case, conversation, on):
    current = expect(case, path(conversation) + "/settings")
    update = {"expected_revision": current["revision"], "provider": "codex", "honor_no_reply": True,
              "parallel_deep": on}
    settings = expect(case, path(conversation) + "/settings", 200, "PUT", update)
    assert settings.get("parallel_deep", False) is on, settings


def join(case, conversation, window, key, number):
    pending = {**window_request(intake(case, conversation, key, number), key, 1), "window_id": window}
    return expect(case, path(conversation) + "/window", 201, "POST", pending)["status"]


def slot_runs(case, conversation):
    return case.rows("SELECT r.id,r.state,r.deep_slot,r.session_id,m.text FROM production_runs r "
                     "JOIN messages m ON m.id=r.message_id WHERE r.conversation_id=? AND r.role='deep' "
                     "AND r.deep_slot>0 ORDER BY r.scope_sequence", (conversation,))


def run(case):
    first = case.conversation
    for role in ("deep", "fast"):
        case.fixture.write_private(case.workspaces[role] / "mode", b"hold")
    switch(case, first, True)
    key = "parallel:1"
    window = expect(case, path(first) + "/window", 201, "POST",
                    window_request(intake(case, first, key, 1), key))["status"]["window_id"]
    writer = ready(case, first, "deep", "running")
    # The Codex five-hour quota gate: at 90 % used no parallel turn starts.
    join(case, first, window, "parallel:2", 2)
    time.sleep(13)  # Past the gate's 10 s cache and many pool passes.
    assert slot_runs(case, first) == [], "quota gate must stay closed at 90 %"
    case.write_quota(10)
    # A burst while the writer's turn is held.
    join(case, first, window, "parallel:3", 3)

    def two_slots():
        rows = slot_runs(case, first)
        return rows if len(rows) == 2 else None
    slots = wait_for(two_slots, "two read-only parallel Deep slot runs", 60)
    assert [row["text"].rsplit(" ", 1)[1] for row in slots] == ["2", "3"], slots
    assert len({row["session_id"] for row in slots}) == 2 and all(row["deep_slot"] > 0 for row in slots)
    # The conversation's Deep status stays the writer's.
    assert status(case, first, phase="running")["run_id"] == writer["run_id"]
    # Slots run on the read-only Fast profile: release them there.
    for number in (2, 3):
        (case.workspaces["fast"] / f"release-{number}").touch()

    def accepted():
        rows = slot_runs(case, first)
        return rows if all(row["state"] == "succeeded" for row in rows) else None
    slots = wait_for(accepted, "server-accepted parallel answers", 60)
    for row in slots:
        projection = expect(case, path(first) + "/execution?run_id=" + row["id"])
        assert projection.get("parallel_deep") is True and projection.get("concurrent_deep") is True, projection
        retired = case.rows("SELECT state FROM session_bindings WHERE id=?", (row["session_id"],))
        wait_for(lambda: case.rows("SELECT state FROM session_bindings WHERE id=?", (row["session_id"],))
                 [0]["state"] == "retired" or None, "used slot session retired", 20)
        assert retired
    # The writer answers its own input only.
    (case.workspaces["fast"] / "release-1").touch()
    (case.workspaces["deep"] / "release-1").touch()
    wait_for(lambda: status(case, first, phase="completed", run=writer["run_id"]), "writer accepted", 60)
    writers = case.rows("SELECT id FROM production_runs WHERE conversation_id=? AND role='deep' AND deep_slot=0",
                        (first,))
    assert [row["id"] for row in writers] == [writer["run_id"]], writers
    # The writer's next turn is told the parallel answers, once.
    join(case, first, window, "parallel:4", 4)
    second_writer = ready(case, first, "deep", "running", previous=writer["run_id"])
    told = case.rows("SELECT run_id,noted_by_run_id FROM production_parallel_deep_notes ORDER BY run_id")
    assert {row["run_id"] for row in told} == {row["id"] for row in slots}, told
    assert {row["noted_by_run_id"] for row in told} == {second_writer["run_id"]}, told
    # A further input gets a slot that outlives the writer's turn: the
    # owner's parallel Stop reaches it.
    join(case, first, window, "parallel:5", 5)
    wait_for(lambda: len(slot_runs(case, first)) == 3 or None, "third slot run", 60)
    (case.workspaces["fast"] / "release-4").touch()
    (case.workspaces["deep"] / "release-4").touch()
    wait_for(lambda: status(case, first, phase="completed", run=second_writer["run_id"]),
             "second writer accepted", 60)
    stopped = expect(case, path(first) + "/parallel/stop", 200, "POST", {"request_key": "parallel:pstop"})
    assert len(stopped["stopped"]) == 1, stopped

    def slot_stopped(index):
        rows = case.rows("SELECT r.id,r.state,t.terminal_kind FROM production_runs r LEFT JOIN "
                         "production_terminal_evidence t ON t.run_id=r.id WHERE r.conversation_id=? AND "
                         "r.role='deep' AND r.deep_slot>0 ORDER BY r.scope_sequence", (first,))
        return rows if len(rows) > index and rows[index]["terminal_kind"] == "stopped" else None
    wait_for(lambda: slot_stopped(2), "parallel Stop reaches the slot past the writer turn", 60)
    # The owner's Stop of a running writer stops its live slot too.
    join(case, first, window, "parallel:6", 6)
    third_writer = ready(case, first, "deep", "running", previous=second_writer["run_id"])
    join(case, first, window, "parallel:7", 7)
    wait_for(lambda: len(slot_runs(case, first)) == 4 or None, "fourth slot run", 60)
    live = ready(case, first, "deep", "running", run=third_writer["run_id"])
    stop = {"run_id": live["run_id"], "expected_revision": live["revision"],
            "expected_control_revision": live["control_revision"], "request_key": "parallel:stop"}
    code, receipt, _ = case.request(path(first) + "/stop", "POST", stop)
    assert code == 200, (code, receipt)

    def stopped():
        rows = case.rows("SELECT r.id,r.state,t.terminal_kind FROM production_runs r LEFT JOIN "
                         "production_terminal_evidence t ON t.run_id=r.id WHERE r.conversation_id=? AND "
                         "r.role='deep' AND r.deep_slot>0 ORDER BY r.scope_sequence", (first,))
        return rows if len(rows) == 4 and rows[-1]["terminal_kind"] == "stopped" else None
    fanned = wait_for(stopped, "owner Stop reaches the live slot", 60)
    assert fanned[-1]["state"] == "cancelled", fanned
    # Switch off: a second conversation's burst is answered by its writer alone.
    second = expect(case, "/api/v2/conversations", 201, "POST",
                    {"client_request_id": "synthetic:parallel-off", "name": "Synthetic parallel off"})["conversation_id"]
    key = "off:1"
    off_window = expect(case, path(second) + "/window", 201, "POST",
                        window_request(intake(case, second, key, 11), key))["status"]["window_id"]
    ready(case, second, "deep", "running")
    join(case, second, off_window, "off:2", 12)
    time.sleep(3)
    assert slot_runs(case, second) == []
    # Review switched on mid-slot: the slot's proposal is never server
    # accepted. When the window closes (the owner stops the writer) the drain
    # deadline withdraws it in this live process: abandoned, input back to
    # the writer, and the window closes now (not after the hard deadline).
    third = expect(case, "/api/v2/conversations", 201, "POST",
                   {"client_request_id": "synthetic:parallel-review", "name": "Synthetic review"})["conversation_id"]
    switch(case, third, True)
    key = "review:1"
    review_window = expect(case, path(third) + "/window", 201, "POST",
                           window_request(intake(case, third, key, 21), key))["status"]["window_id"]
    held = ready(case, third, "deep", "running")
    join(case, third, review_window, "review:2", 22)
    wait_for(lambda: len(slot_runs(case, third)) == 1 or None, "review-case slot run", 60)
    current = expect(case, path(third) + "/settings")
    expect(case, path(third) + "/settings", 200, "PUT",
           {"expected_revision": current["revision"], "provider": "codex", "honor_no_reply": True,
            "review_before_accepting": True})
    (case.workspaces["fast"] / "release-21").touch()
    (case.workspaces["fast"] / "release-22").touch()
    proposal = wait_for(lambda: (row if (row := slot_runs(case, third)[0])["state"] == "awaiting_acceptance"
                                 else None), "slot proposal awaiting review", 60)
    # Fast proposals of this window wait for the owner too (review on):
    # accept them, so only the slot proposal is left undecided.
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        waiting = case.rows("SELECT id FROM production_runs WHERE conversation_id=? AND role='fast' "
                            "AND state='awaiting_acceptance'", (third,))
        for row in waiting:
            accept(case, third, {"run_id": row["id"], "_role": "fast"}, "review:fast:" + row["id"])
        if not waiting and case.rows("SELECT count(*) AS n FROM production_runs WHERE conversation_id=? "
                                     "AND role='fast' AND state='succeeded'", (third,))[0]["n"] >= 2:
            break
        time.sleep(0.5)
    live = ready(case, third, "deep", "running", run=held["run_id"])
    code, _, _ = case.request(path(third) + "/stop", "POST", {
        "run_id": live["run_id"], "expected_revision": live["revision"],
        "expected_control_revision": live["control_revision"], "request_key": "review:stop"})
    assert code == 200, code

    def withdrawn():
        rows = case.rows("SELECT t.terminal_kind FROM production_terminal_evidence t WHERE t.run_id=?",
                         (proposal["id"],))
        return rows if rows and rows[0]["terminal_kind"] == "abandoned" else None
    wait_for(withdrawn, "unaccepted slot proposal withdrawn at the drain deadline", 90)
    assert case.rows("SELECT count(*) AS n FROM production_parallel_deep_deferrals WHERE run_id=?",
                     (proposal["id"],)) == [{"n": 1}]
    wait_for(lambda: case.rows("SELECT state FROM execution_windows WHERE id=?", (review_window,))
             [0]["state"] == "closed" or None, "review-case window closed", 60)
    case.stop()
    final = case.rows("SELECT id,conversation_id,state FROM execution_windows")
    assert all(row["state"] == "closed" for row in final), final
    leftover = case.rows("SELECT count(*) AS n FROM session_bindings WHERE deep_slot>0 AND state!='retired'")
    assert leftover == [{"n": 0}], leftover
    return {"slots": slots, "stopped": fanned, "notes": told, "windows": final, "trace": case.trace()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    record = {"source": args.source, "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              "actual_provider": False, "passed": False}
    case = ServiceRolesCase(args.source, quota_used=90)
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
