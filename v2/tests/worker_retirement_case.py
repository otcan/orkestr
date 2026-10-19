"""Disposable configured Worker retirement case and coherent private evidence."""
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import time

import worker_tasks_http as tasks
from worker_control_http import exact_status, intent

ordinary = tasks.ordinary


class RetirementCase(tasks.TaskCase):
    def __init__(self):
        super().__init__()
        self.exits = []
        self.logs = []
        self.checkpoints = []

    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("worker_retirement_peer.py"),
                        self.root / "synthetic-provider")
        (self.root / "synthetic-provider").chmod(0o700)

    def stop(self):
        process = self.process
        try:
            super().stop()
        finally:
            if process is not None:
                self.exits.append(process.returncode)

    def snapshot(self):
        path = (self.home / "core.sqlite3").resolve(strict=True)
        assert path.parent == self.home.resolve(strict=True)
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("BEGIN")
            db.row_factory = sqlite3.Row
            queries = {
                "runs": "SELECT id,context_id,incarnation_id,role,session_id,native_session_id,state,message_id FROM production_runs ORDER BY role,id",
                "accepted_retirements": "SELECT context_id,incarnation_id,prior_run_id FROM production_graceful_retirements ORDER BY prior_run_id",
                "stopped_retirements": "SELECT context_id,incarnation_id,prior_run_id FROM production_stopped_retirements ORDER BY prior_run_id",
                "tasks": "SELECT id,parent_run_id,state,claim_hash FROM worker_tasks ORDER BY id",
                "inbox": "SELECT sequence,message_id,state,admitted_run_id FROM reasoning_inbox ORDER BY sequence",
                "observations": "SELECT run_id,kind,event_id FROM production_observations ORDER BY run_id,event_id",
                "resume": "SELECT prior_run_id,state FROM production_resume_metadata ORDER BY prior_run_id",
            }
            return {key: [dict(row) for row in db.execute(query)] for key, query in queries.items()}

    def checkpoint(self, name):
        self.checkpoints.append({"name": name, "snapshot": self.snapshot(), "trace": self.trace()})

    def clean_stop(self):
        assert self.process is not None and self.process.poll() is None
        self.trace()
        self.process.send_signal(signal.SIGINT)
        code = self.process.wait(timeout=8)
        self.exits.append(code)
        self.logs.append(self.process.stderr.read(65536))
        self.process.stderr.close()
        self.process = None
        assert code == 0, "graceful server shutdown failed"
        ordinary.wait_for(self.peer_gone, "all original native children must be gone")

    def refuse_restart(self):
        before = self.snapshot()
        trace = self.trace()
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "ORKESTR_V2_HOME": str(self.home),
                       "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}", "ORKESTR_V2_ORIGIN": self.origin,
                       "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap,
                       "ORKESTR_V2_EXECUTION_CONFIG": str(self.root / "execution.json")}
        self.process = subprocess.Popen([str(ordinary.binary)], env=environment,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        code = self.process.wait(timeout=6)
        self.exits.append(code)
        self.logs.append(self.process.stderr.read(65536))
        self.process.stderr.close()
        self.process = None
        assert code != 0, "unproven Worker must refuse configured restart"
        assert self.snapshot() == before, "refused restart changed authoritative metadata"
        assert self.trace() == trace, "refused restart launched a native child"

    def stop_run(self, run, key):
        status = ordinary.wait_for(lambda: (s if (s := exact_status(self, run))["capabilities"]["stop"] else None),
                                   "exact Stop capability unavailable")
        body = intent(status, key)
        code, receipt, _ = self.request(self.path + "/stop", "POST", body)
        assert code == 200 and receipt["run_id"] == run
        assert self.request(self.path + "/stop", "POST", body)[:2] == (200, receipt)
        return body, receipt

    def accept_run(self, run, key):
        code, receipt, _ = self.accept(run, self.completion(run), key)
        assert code == 200 and receipt["outcome"] == "succeeded", receipt

    def release_parent(self, number):
        (self.workspace / f"release-deep-{number}").touch()
        status = ordinary.wait_for(lambda: self.phase("awaiting_acceptance"), "parent proposal missing")
        assert status["run_id"] == self.parent["id"]
        self.accept_run(self.parent["id"], f"accept-parent-{number}")

    def fresh_restart(self, number):
        prior = self.parent
        before = self.snapshot()
        before_trace = self.trace()
        (self.workspace / "expected-parent-native").write_text(prior["native_session_id"])
        (self.workspace / "restart-parent").touch()
        self.start(configured=True)
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline:
            assert self.request(self.path + "/execution")[0] == 200
            assert self.trace() == before_trace, "restart dispatched without fresh eligible input"
            time.sleep(0.01)
        assert self.message(number)[0] == 202
        self.parent = ordinary.wait_for(lambda: self.role_state("deep", "running"), "fresh restarted parent missing")
        assert self.parent["id"] != prior["id"]
        assert self.parent["session_id"] == prior["session_id"]
        assert self.parent["native_session_id"] == prior["native_session_id"]
        rows = self.snapshot()["runs"]
        original = next(row for row in before["runs"] if row["id"] == prior["id"])
        current = next(row for row in rows if row["id"] == self.parent["id"])
        assert current["context_id"] == original["context_id"]
        assert current["incarnation_id"] != original["incarnation_id"]
        # Owner tasks from the retired parent cannot become a fresh dispatch.
        stale = self.input("queued")
        stale["parent_run_id"] = prior["id"]
        writes = len([row for row in self.trace() if row["kind"] == "turn"])
        assert self.request(self.path + "/worker-tasks", "POST", stale)[0] in (409, 503)
        assert len([row for row in self.trace() if row["kind"] == "turn"]) == writes
        self.checkpoint("fresh-restart")
