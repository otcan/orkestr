"""Actual cookie-authenticated task dispatch; only isolated synthetic input/peers."""
import json
from pathlib import Path
import shutil
import socket
import uuid

import worker_execution_http as worker
from worker_control_http import exact_status, intent

ordinary = worker.ordinary
INSTRUCTIONS = {name: f"TASK {name}: independently inspect only synthetic section {name}.\nReturn its count."
                for name in ["alpha", "beta", "gamma", "delta", "held", "deleted", "queued"]}


class TaskCase(worker.WorkerCase):
    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("worker_task_peer.py"), self.root / "synthetic-provider")
        (self.root / "synthetic-provider").chmod(0o700)
        file = self.root / "execution.json"
        config = json.loads(file.read_text())
        config["worker"] = {"mode": "owner-tasks-v1", "lifetime_ms": 30000}
        file.write_text(json.dumps(config))
        (self.workspace / "expected-tasks.json").write_text(json.dumps(INSTRUCTIONS))
        (self.workspace / "hold-worker").touch()

    def task_list(self):
        code, body, _ = self.request(self.path + "/worker-tasks?parent_run_id=" + self.parent["id"])
        assert code == 200
        assert body["schema_version"] == 1 and body["conversation_id"] == self.conversation
        assert body["parent_run_id"] == self.parent["id"]
        return body

    def task(self, receipt, phase=None):
        tasks = [task for task in self.task_list()["tasks"] if task["task"]["task_id"] == receipt["task_id"]]
        assert len(tasks) == 1
        return tasks[0] if phase is None or tasks[0]["phase"] == phase else None

    def input(self, name):
        return {"parent_run_id": self.parent["id"],
                "expected_control_revision": exact_status(self, self.parent["id"])["control_revision"],
                "request_key": "owner-task:" + name, "title": "Synthetic " + name,
                "instructions": INSTRUCTIONS[name], "lifetime_ms": 30000}

    def create(self, name):
        body = self.input(name)
        code, receipt, _ = self.request(self.path + "/worker-tasks", "POST", body)
        assert code == 200, receipt
        assert receipt["parent_run_id"] == self.parent["id"]
        return body, receipt


def begin(case):
    case.stop()
    case.configure()
    case.start(configured=True)
    assert case.message()[0] == 202
    case.parent = ordinary.wait_for(lambda: case.role_state("deep", "running"), "parent did not start")
    ordinary.wait_for(lambda: case.task_list()["can_create"], "owned task scheduler not available")
    assert case.task_list()["tasks"] == []
    assert not [row for row in case.trace() if row["role"] == "worker"]


def task_running(case, receipt):
    return ordinary.wait_for(lambda: case.task(receipt, "running"), "explicit task Worker did not start")


def stop_parent(case):
    status = ordinary.wait_for(lambda: (s if (s := exact_status(case, case.parent["id"]))["capabilities"]["stop"] else None),
                               "parent Stop unavailable")
    assert case.request(case.path + "/stop", "POST", intent(status, "stop-task-parent"))[0] == 200
    assert not case.rows("SELECT id FROM worker_tasks WHERE state IN ('queued','claimed') OR claim_hash IS NOT NULL"), \
        "parent Stop must durably hold pending claims before its response"
    ordinary.wait_for(case.peer_gone, "parent Stop must reap every owned task child")
    assert not case.task_list()["can_create"]


def distinct_tasks_acceptance_and_independent_stop(case):
    begin(case)
    before = case.inbox()
    body, alpha = case.create("alpha")
    _, beta = case.create("beta")
    a, b = task_running(case, alpha), task_running(case, beta)
    assert a["run_id"] != b["run_id"]
    runs = {run["id"]: run for run in case.runs()}
    assert runs[a["run_id"]]["session_id"] != runs[b["run_id"]]["session_id"]
    assert runs[a["run_id"]]["native_session_id"] != runs[b["run_id"]]["native_session_id"]
    turns = [row for row in case.trace() if row["kind"] == "turn" and row["role"] == "worker"]
    assert {row["instructions"] for row in turns} == {INSTRUCTIONS["alpha"], INSTRUCTIONS["beta"]}
    assert len(turns) == 2
    assert {row["message"] for row in turns} == {alpha["source_message_id"]}
    assert alpha["source_event_id"] == beta["source_event_id"] == case.parent["event_id"]
    old_alpha_status = exact_status(case, a["run_id"])
    (case.workspace / "release-alpha").touch()
    ordinary.wait_for(lambda: case.task(alpha, "awaiting_acceptance"), "task proposal missing")
    # A committed proposal must close its local Stop availability immediately.
    assert case.request(case.path + "/stop", "POST", intent(old_alpha_status, "late-alpha-stop"))[0] == 503
    assert case.task(beta, "running")
    assert case.accept(a["run_id"], case.completion(a["run_id"]), "accept-task-alpha")[0] == 200
    assert case.task(alpha, "completed")
    bstatus = ordinary.wait_for(lambda: (s if (s := exact_status(case, b["run_id"]))["capabilities"]["stop"] else None),
                                "independent beta Stop unavailable")
    assert case.request(case.path + "/stop", "POST", intent(bstatus, "stop-task-beta"))[0] == 200
    ordinary.wait_for(lambda: case.task(beta, "cancelled"), "beta terminal Stop proof missing")
    assert case.role_state("deep", "running")["id"] == case.parent["id"]
    assert case.task(alpha, "completed")
    assert case.inbox() == before
    (case.workspace / "release-deep").touch()
    ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "parent completion missing")
    assert case.accept(case.parent["id"], case.completion(case.parent["id"]), "accept-task-parent")[0] == 200
    assert case.request(case.path + "/worker-tasks", "POST", body)[:2] == (200, alpha)
    assert not case.task_list()["can_create"]
    assert len([row for row in case.trace() if row["kind"] == "turn"]) == 3


def task_auth_and_control_refusals_have_no_effects(case):
    begin(case)
    body = case.input("alpha")
    base = case.path + "/worker-tasks"
    assert case.request(base, "POST", dict(body, expected_control_revision=body["expected_control_revision"] + 1))[0] == 409
    assert case.request(base, "POST", dict(body, parent_run_id=str(uuid.uuid4())))[0] == 503
    assert case.request(base, "POST", dict(body, provider_auth="forbidden"))[0] == 400
    assert case.request(base, "POST", body, extra={"x-orkestr-csrf": "wrong"})[0] == 403
    assert case.request(base, "POST", body, extra={"Origin": "https://invalid.example"})[0] == 403
    assert case.request(base, "POST", body, browser=False)[0] == 401
    for query in ["", "?parent_run_id=bad", "?parent_run_id=" + str(uuid.UUID(int=0)),
                  "?parent_run_id=" + case.parent["id"] + "&extra=1",
                  "?parent_run_id=" + case.parent["id"] + "&parent_run_id=" + case.parent["id"]]:
        assert case.request(base + query)[0] == 400
    foreign = ordinary.Case()
    try:
        foreign.setup()
        headers = {"Cookie": foreign.cookie, "x-orkestr-csrf": foreign.csrf}
        assert case.request(base, "POST", body, extra=headers)[0] == 401
        assert case.request(base + "?parent_run_id=" + case.parent["id"], extra=headers)[0] == 401
    finally:
        foreign.cleanup()
    assert case.task_list()["tasks"] == []
    assert not case.rows("SELECT id FROM worker_tasks")
    assert not [row for row in case.trace() if row["role"] == "worker"]
    stop_parent(case)


def lost_create_response_replays_one_task_and_one_native_turn(case):
    begin(case)
    body = case.input("alpha")
    raw = json.dumps(body).encode()
    headers = (f"POST {case.path}/worker-tasks HTTP/1.1\r\nHost: 127.0.0.1:{case.port}\r\n"
               f"Origin: {case.origin}\r\nCookie: {case.cookie}\r\nx-orkestr-csrf: {case.csrf}\r\n"
               f"Content-Type: application/json\r\nContent-Length: {len(raw)}\r\nConnection: close\r\n\r\n").encode()
    # This exact child's listener was proved before any request; never follow a redirect.
    with socket.create_connection(("127.0.0.1", case.port), timeout=3) as stream:
        stream.sendall(headers + raw)
        rows = ordinary.wait_for(lambda: case.rows("SELECT id FROM worker_tasks WHERE request_key=?", (body["request_key"],)),
                                 "task create did not commit before response loss")
    code, receipt, _ = case.request(case.path + "/worker-tasks", "POST", body)
    assert code == 200 and receipt["task_id"] == rows[0]["id"]
    task_running(case, receipt)
    assert case.request(case.path + "/worker-tasks", "POST", body)[:2] == (200, receipt)
    assert case.request(case.path + "/worker-tasks", "POST", dict(body, instructions="changed"))[0] == 409
    assert len(case.task_list()["tasks"]) == 1
    assert len([row for row in case.trace() if row["kind"] == "turn" and row["role"] == "worker"]) == 1
    stop_parent(case)
    assert case.request(case.path + "/worker-tasks", "POST", body)[:2] == (200, receipt)
    assert case.task(receipt, "held")


def bounded_parallel_tasks_hold_delete_and_parent_stop(case):
    begin(case)
    live = [case.create(name)[1] for name in ["alpha", "beta", "gamma", "delta"]]
    for receipt in live:
        task_running(case, receipt)
    assert len([row for row in case.trace() if row["kind"] == "turn" and row["role"] == "worker"]) == 4
    held_body, held = case.create("held")
    deleted_body, deleted = case.create("deleted")
    _, queued = case.create("queued")
    assert case.task(held, "queued") and case.task(deleted, "queued") and case.task(queued, "queued")
    assert case.request(case.path + "/worker-tasks/" + held["task_id"] + "/hold", "POST", {})[0] == 204
    assert case.request(case.path + "/worker-tasks/" + deleted["task_id"] + "/payload", "DELETE")[0] == 204
    assert case.task(held, "held")
    tombstone = case.task(deleted, "held")
    assert tombstone["title"] is None and not tombstone["instructions_available"]
    assert case.request(case.path + "/worker-tasks", "POST", held_body)[:2] == (200, held)
    assert case.request(case.path + "/worker-tasks", "POST", deleted_body)[:2] == (200, deleted)
    stop_parent(case)
    assert case.task(queued, "held")
    turns = [row for row in case.trace() if row["kind"] == "turn" and row["role"] == "worker"]
    assert len(turns) == 4
    assert {row["task"] for row in turns} == {"alpha", "beta", "gamma", "delta"}
    assert not any(task["phase"] == "completed" for task in case.task_list()["tasks"])
    assert not case.rows("SELECT run_id FROM production_observations WHERE kind='stopped' AND run_id!=?", (case.parent["id"],))


def pending_with_live_siblings(case):
    begin(case)
    for name in ["alpha", "beta", "gamma", "delta"]:
        task_running(case, case.create(name)[1])
    _, queued = case.create("queued")
    assert case.task(queued, "queued")
    case.trace()  # own every native host identity before the parent is fenced
    return queued


def parent_proposal_durably_holds_unissued_tasks(case):
    queued = pending_with_live_siblings(case)
    (case.workspace / "release-deep").touch()
    ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "parent proposal missing")
    assert case.rows("SELECT state,claim_hash FROM worker_tasks WHERE id=?", (queued["task_id"],)) == [
        {"state": "held", "claim_hash": None}]
    ordinary.wait_for(case.worker_gone, "parent proposal must reap its fenced Workers")
    assert case.task(queued, "held")
    assert not any(row.get("task") == "queued" for row in case.trace() if row["kind"] == "turn")
    assert not case.rows("SELECT run_id FROM production_observations WHERE kind='stopped'")


def machine_revocation_durably_holds_unissued_tasks(case):
    queued = pending_with_live_siblings(case)
    case.revoke_machine()
    # No task-list or scheduling call precedes this raw durability check.
    assert case.rows("SELECT state,claim_hash FROM worker_tasks WHERE id=?", (queued["task_id"],)) == [
        {"state": "held", "claim_hash": None}]
    ordinary.wait_for(case.peer_gone, "revocation must reap parent and independent Workers")
    assert case.task(queued, "held")
    assert not any(row.get("task") == "queued" for row in case.trace() if row["kind"] == "turn")
    assert not case.rows("SELECT run_id FROM production_observations WHERE kind IN ('stopped','completed_proposal')")


if __name__ == "__main__":
    worker.WorkerCase = TaskCase
    worker.SCENARIOS = [distinct_tasks_acceptance_and_independent_stop,
                        task_auth_and_control_refusals_have_no_effects,
                        lost_create_response_replays_one_task_and_one_native_turn,
                        bounded_parallel_tasks_hold_delete_and_parent_stop,
                        parent_proposal_durably_holds_unissued_tasks,
                        machine_revocation_durably_holds_unissued_tasks]
    worker.main()
