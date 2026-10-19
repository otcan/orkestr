"""One ordinary conversation with independently configured Deep and Fast roles."""
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3

from owned_execution_group import GroupCase, stop_request, write_private
from owned_execution_http import Case, wait_for


class FastCase(GroupCase):
    def setup(self):
        Case.setup(self)
        self.conversations = [self.conversation, self.conversation]
        self.paths = [self.path, self.path + "/fast"]

    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("owned_fast_peer.py"), self.root / "synthetic-provider")
        second_file = self.root / "second-execution.json"
        second = json.loads(second_file.read_text())
        second["role"] = "fast"
        write_private(second_file, second)
        for index, role in enumerate(("deep", "fast")):
            (self.workspaces[index] / "role").write_text(role)
            (self.workspaces[index] / "mode").write_text("complete")

    def begin(self, deep="complete", fast="complete"):
        self.stop()
        self.configure()
        for index, mode in enumerate((deep, fast)):
            (self.workspaces[index] / "mode").write_text(mode)
        self.start(configured=True)
        assert self.message()[0] == 202

    def ready(self, index, phase="awaiting_acceptance", previous=None):
        def select():
            status = self.status(index, phase)
            if not status or status["run_id"] == previous:
                return None
            if phase == "running" and (not status["capabilities"]["stop"] or not status["progress"]):
                return None
            return status
        return wait_for(select, "exact role projection " + str(index) + " " + phase)

    def accept(self, index, key):
        status = self.ready(index)
        body = {**status["acceptance_candidate"], "expected_revision": status["revision"], "request_key": key}
        code, receipt, _ = self.request(self.path + "/accept", "POST", body)
        assert code == 200 and receipt["outcome"] == "succeeded", (code, receipt)
        assert receipt["run_id"] == status["run_id"]
        assert self.request(self.path + "/accept", "POST", body)[:2] == (200, receipt)
        return receipt

    def stop_role(self, index, key):
        status = self.ready(index, "running")
        assert status["capabilities"]["stop"]
        body = stop_request(status, key)
        code, receipt, _ = self.request(self.paths[index] + "/stop", "POST", body)
        assert code == 200, receipt
        self.ready(index, "cancelled")
        wait_for(self.probes[index].gone, "exact role native tree cleanup")
        assert self.request(self.paths[index] + "/stop", "POST", body)[:2] == (200, receipt)
        return body, receipt

    def ledger(self):
        uri = (self.home / "core.sqlite3").as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("BEGIN")
            return {"runs": [dict(row) for row in db.execute(
                "SELECT id,role,state,session_id,native_session_id,context_id,incarnation_id,message_id,lease_generation FROM production_runs ORDER BY role,scope_sequence")],
                "inbox": [tuple(row) for row in db.execute("SELECT message_id,state FROM reasoning_inbox ORDER BY sequence")],
                "accepted": db.execute("SELECT count(*) FROM production_acceptances").fetchone()[0],
                "held": db.execute("SELECT count(*) FROM ordinary_input_holds").fetchone()[0],
                "retirements": db.execute("SELECT count(*) FROM production_graceful_retirements").fetchone()[0]}

    def turns(self, index):
        return [row for row in self.trace_for(index) if row["kind"] == "turn"]
