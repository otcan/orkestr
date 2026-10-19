"""Synthetic Fast restart fixture; all durable inspection is read-only."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

from owned_execution_group import write_private
from owned_execution_http import binary, wait_for
from owned_fast_case import FastCase


class StoppedFastCase(FastCase):
    def __init__(self):
        super().__init__()
        self.server_exits = []
        self.refused_exits = []
        self.snapshots = []
        self.expected_abrupt_server_exit = False

    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("owned_fast_stopped_peer.py"),
                        self.root / "synthetic-provider")

    def select_fast_only(self):
        self.manifest["configurations"] = [str(self.root / "second-execution.json")]
        write_private(self.root / "execution-set.json", self.manifest)

    def begin(self, fast="hold", with_deep=False):
        self.stop()
        self.configure()
        for workspace in self.workspaces:
            (workspace / "mode").write_text("hold")
        (self.workspaces[1] / "mode").write_text(fast)
        if not with_deep:
            self.select_fast_only()
        self.start(configured=True)
        assert self.message()[0] == 202

    def stop(self):
        process = self.process
        try:
            super().stop()
        finally:
            if process is not None:
                self.server_exits.append(process.returncode)

    def refused_restart(self):
        """No HTTP before readiness; this owned child must exit before serving."""
        assert self.process is None
        before, trace = self.snapshot(), self.trace()
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin",
            "ORKESTR_V2_HOME": str(self.home), "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}",
            "ORKESTR_V2_ORIGIN": self.origin, "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap,
            "ORKESTR_V2_EXECUTION_SET": str(self.root / "execution-set.json")}
        process = subprocess.Popen([str(binary)], env=environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            _, error = process.communicate(timeout=6)
            assert process.returncode != 0, "unproven Fast restart was allowed"
            assert len(error) <= 16384
            self.refused_exits.append(process.returncode)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            process.stderr.close()
        assert self.snapshot() == before, "refused restart changed durable execution"
        assert self.trace() == trace, "refused restart launched a native child"

    def snapshot(self, label=None):
        uri = (self.home / "core.sqlite3").as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("BEGIN")
            def rows(query):
                return [dict(row) for row in db.execute(query)]
            result = {
                "runs": rows("SELECT id,role,state,session_id,native_session_id,context_id,"
                    "incarnation_id,message_id,binding_generation,lease_generation,attempt "
                    "FROM production_runs ORDER BY role,scope_sequence"),
                "supervisors": rows("SELECT context_id,incarnation_id,generation,lease_deadline_ms "
                    "FROM production_supervisors ORDER BY context_id"),
                "inbox": rows("SELECT message_id,event_id,state,admitted_run_id "
                    "FROM reasoning_inbox ORDER BY sequence"),
                "held": rows("SELECT event_id FROM ordinary_input_holds ORDER BY event_id"),
                "acceptances": rows("SELECT run_id,event_id FROM production_acceptances ORDER BY rowid"),
                "observations": rows("SELECT run_id,kind,event_id,receipt_state "
                    "FROM production_observations ORDER BY rowid"),
                "cancellations": rows("SELECT run_id,event_id,receipt_state,inflight_status "
                    "FROM production_cancellations ORDER BY rowid"),
                "stopped_retirements": rows("SELECT context_id,incarnation_id,prior_run_id,"
                    "stopped_event_id,session_id,binding_generation "
                    "FROM production_stopped_retirements ORDER BY prior_run_id"),
                "accepted_retirements": rows("SELECT context_id,incarnation_id,prior_run_id "
                    "FROM production_graceful_retirements ORDER BY prior_run_id"),
                "resume": rows("SELECT prior_run_id,session_id FROM production_resume_metadata "
                    "ORDER BY prior_run_id"),
            }
        if label:
            self.snapshots.append({"label": label, "ledger": result})
        return result

    def idle_after_restart(self, before):
        trace = self.trace()
        deadline = time.monotonic() + .3
        samples = 0
        while time.monotonic() < deadline:
            code, status, _ = self.request(self.paths[1] + "/execution")
            assert code in (200, 204)
            assert code == 204 or status["phase"] == "cancelled"
            current = self.snapshot()
            for key in ("runs", "inbox", "held", "acceptances", "observations", "cancellations"):
                assert current[key] == before[key], key
            assert self.trace() == trace, "restart dispatched without fresh eligible input"
            samples += 1
            time.sleep(.02)
        assert samples >= 2
        return samples

    def fast_config_hash(self):
        return hashlib.sha256((self.root / "second-execution.json").read_bytes()).hexdigest()

    def gone(self):
        wait_for(self.peer_gone, "all observed synthetic native identities reaped")
