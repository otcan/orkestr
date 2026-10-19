"""Two configured conversations; all accounts, instructions and peers are synthetic."""
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import urllib.request

import owned_execution_http as ordinary
from owned_execution_group import GroupCase, write_private
from owned_native_probe import process_start
from worker_tasks_http import INSTRUCTIONS


class TaskGroupCase(GroupCase):
    def __init__(self):
        super().__init__()
        self.evidence = {"requests": [], "snapshots": {}}

    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("worker_task_peer.py"),
                        self.root / "synthetic-provider")
        (self.root / "synthetic-provider").chmod(0o700)
        for index, filename in enumerate(self.manifest["configurations"]):
            config = json.loads(Path(filename).read_text())
            config["worker"] = {"mode": "owner-tasks-v1", "lifetime_ms": 30000}
            write_private(Path(filename), config)
            workspace = self.workspaces[index]
            name = ("alpha", "beta")[index]
            write_private(workspace / "expected-tasks.json", {name: INSTRUCTIONS[name]})
            for role in ("deep", "worker"):
                (workspace / f"hold-{role}").touch()

    def expect(self, path, status, method="GET", body=None):
        code, reply, _ = self.request(path, method, body)
        # These callers supply synthetic task/control data, never setup secrets.
        self.evidence["requests"].append({"method": method, "path": path,
                                          "request": body, "status": code, "response": reply})
        assert code == status, (method, path, status, code, reply)
        return reply

    def exact(self, index, run):
        code, status, _ = self.request(self.paths[index] + "/execution?run_id=" + run)
        self.trace()
        assert code == 200 and status["run_id"] == run
        assert status["conversation_id"] == self.conversations[index]
        return status

    def running(self, index, run):
        status = self.exact(index, run)
        return status if (status["phase"] == "running" and status["progress"]
                          and status["capabilities"]["stop"]) else None

    def task_list(self, index):
        parent = self.parents[index]["run_id"]
        code, body, _ = self.request(self.paths[index] + "/worker-tasks?parent_run_id=" + parent)
        assert code == 200 and body["schema_version"] == 1
        assert body["conversation_id"] == self.conversations[index]
        assert body["parent_run_id"] == parent
        return body

    def task(self, index, receipt, phase=None):
        rows = [row for row in self.task_list(index)["tasks"]
                if row["task"]["task_id"] == receipt["task_id"]]
        assert len(rows) == 1 and rows[0]["task"] == receipt
        return rows[0] if phase is None or rows[0]["phase"] == phase else None

    def begin(self):
        self.stop()
        self.configure()
        self.start(configured=True)
        self.messages = [self.expect(path + "/messages", 202, "POST", {
            "client_message_id": "synthetic:scope-input", "text": "synthetic ordinary HTTP input"})
            for path in self.paths]
        self.parents = [ordinary.wait_for(lambda index=index: self.status(index, "running"),
                        "independent Deep parent did not start") for index in range(2)]
        for index, parent in enumerate(self.parents):
            ordinary.wait_for(lambda: self.running(index, parent["run_id"]), "parent control/progress")
            ordinary.wait_for(lambda: self.task_list(index)["can_create"], "parent task scheduler")
            assert self.task_list(index)["tasks"] == []
        assert self.parents[0]["run_id"] != self.parents[1]["run_id"]

    def create(self, index):
        name = ("alpha", "beta")[index]
        parent = self.exact(index, self.parents[index]["run_id"])
        body = {"parent_run_id": parent["run_id"],
                "expected_control_revision": parent["control_revision"],
                # Same key in each parent proves the actual parent scope.
                "request_key": "scope-task:one", "title": "Synthetic " + name,
                "instructions": INSTRUCTIONS[name], "lifetime_ms": 30000}
        receipt = self.expect(self.paths[index] + "/worker-tasks", 200, "POST", body)
        assert receipt["conversation_id"] == self.conversations[index]
        assert receipt["parent_run_id"] == parent["run_id"]
        assert receipt["source_message_id"] == self.messages[index]["message_id"]
        assert receipt["source_event_id"] == self.messages[index]["event_id"]
        task = ordinary.wait_for(lambda: self.task(index, receipt, "running"), "owned task did not run")
        ordinary.wait_for(lambda: self.running(index, task["run_id"]), "Worker control/progress")
        return body, receipt, task["run_id"]

    def snapshot(self, index):
        """One read-only cut of this disposable DB; no auth/hash/credential rows."""
        database = (self.home / "core.sqlite3").resolve(strict=True)
        assert database.parent == self.home.resolve(strict=True)
        queries = {
            "tasks": "SELECT id,owner_id,conversation_id,parent_run_id,source_message_id,source_event_id,"
                     "request_key,state,claim_hash IS NOT NULL AS claimed,delegation_id FROM worker_tasks "
                     "WHERE conversation_id=? ORDER BY ordinal",
            "payloads": "SELECT p.task_id,p.title,p.instructions FROM worker_task_payloads p JOIN worker_tasks t "
                        "ON t.id=p.task_id WHERE t.conversation_id=? ORDER BY t.ordinal",
            "runs": "SELECT r.id,r.owner_id,r.conversation_id,r.role,r.state,r.session_id,r.native_session_id,"
                    "r.message_id,r.event_id,r.dispatch_state,b.parent_session_id FROM production_runs r "
                    "JOIN session_bindings b ON b.id=r.session_id WHERE r.conversation_id=? ORDER BY r.id",
            "delegations": "SELECT id,parent_run_id,parent_session_id,worker_session_id,source_message_id,"
                           "source_event_id,state,admitted_run_id FROM worker_provider_delegations "
                           "WHERE conversation_id=? ORDER BY id",
            "inbox": "SELECT sequence,message_id,event_id,state,admitted_run_id FROM reasoning_inbox "
                     "WHERE conversation_id=? ORDER BY sequence",
            "cancellations": "SELECT c.run_id,c.event_id,c.request_key,c.receipt_state,c.inflight_status "
                             "FROM production_cancellations c JOIN production_runs r ON r.id=c.run_id "
                             "WHERE r.conversation_id=? ORDER BY c.run_id",
            "controls": "SELECT c.run_id,c.event_id,c.state FROM production_control_outbox c "
                        "JOIN production_runs r ON r.id=c.run_id WHERE r.conversation_id=? ORDER BY c.run_id",
            "acceptances": "SELECT run_id,completion_event_id,event_id,request_key FROM production_acceptances "
                           "WHERE conversation_id=? ORDER BY run_id",
            "observations": "SELECT o.run_id,o.event_id,o.kind,o.run_sequence,o.receipt_state "
                            "FROM production_observations o JOIN production_runs r ON r.id=o.run_id "
                            "WHERE r.conversation_id=? ORDER BY o.run_id,o.run_sequence",
        }
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("BEGIN")
            db.row_factory = sqlite3.Row
            result = {name: [dict(row) for row in db.execute(query, (self.conversations[index],))]
                      for name, query in queries.items()}
        self.trace()  # capture owned host identities before any caller can Stop
        return result

    def capture(self, label):
        value = [self.snapshot(index) for index in range(2)]
        self.evidence["snapshots"][label] = value
        return value

    def peer(self, index, role):
        rows = [row for row in self.trace_for(index) if row["kind"] == "spawn" and row["role"] == role]
        assert len(rows) == 1
        return rows[0]

    def alive(self, index, role):
        row = self.peer(index, role)
        return process_start(row["pid"]) == row["process_start"]

    def completion(self, index, run):
        request = urllib.request.Request(self.origin + self.paths[index] + "/events", headers={
            "Origin": self.origin, "Cookie": self.cookie})
        with ordinary.opener.open(request, timeout=3) as stream:
            assert stream.status == 200
            for count, line in enumerate(stream):
                assert count < 1000 and len(line) <= 65536
                if line.startswith(b"data: "):
                    event = json.loads(line[6:])
                    payload = event.get("payload_ref_or_safe_payload", {})
                    if (payload.get("run_id") == run and
                            payload.get("observation", {}).get("kind") == "completed_proposal"):
                        return event["event_id"]
        raise AssertionError("missing scoped completion in authenticated HTTP events")
