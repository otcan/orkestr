"""Fresh disposable scope and fixed synthetic role plan, never provider authority."""
import json
from pathlib import Path
import shutil
import sqlite3
import time

from worker_retirement_case import RetirementCase, ordinary


class ContinuationCase(RetirementCase):
    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name("worker_continuation_peer.py"),
                        self.root / "synthetic-provider")
        (self.root / "synthetic-provider").chmod(0o700)
        (self.workspace / "continuation-roles.json").write_text(json.dumps(["deep"]))

    def expect_role(self, role):
        path = self.workspace / "continuation-roles.json"
        roles = json.loads(path.read_text())
        assert role in ("deep", "worker") and len(roles) < 32
        roles.append(role)
        path.write_text(json.dumps(roles))

    def create(self, name):
        self.expect_role("worker")
        return super().create(name)

    def fresh_restart(self, number):
        self.expect_role("deep")
        return super().fresh_restart(number)

    def held(self, message):
        code, page, _ = self.request(self.path + "/held-inputs")
        assert code == 200
        found = [row for row in page["held"] if row["message_id"] == message]
        assert len(found) == 1
        assert not any(row["message_id"] == message for row in self.snapshot()["runs"])
        return found[0]

    def quiet(self, seconds=0.3):
        trace = self.trace()
        before = self.snapshot()
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            assert self.request(self.path + "/execution")[0] == 200
            assert self.trace() == trace, "idle or refused continuation emitted native traffic"
            assert self.snapshot() == before, "idle or refused continuation changed its ledger"
            time.sleep(0.01)

    def fresh_after_stop(self, number):
        prior = self.parent
        old = next(row for row in self.snapshot()["runs"] if row["id"] == prior["id"])
        self.expect_role("deep")
        (self.workspace / "expected-parent-native").write_text(prior["native_session_id"])
        code, message, _ = self.message(number)
        assert code == 202
        self.parent = ordinary.wait_for(lambda: self.role_state("deep", "running"),
                                        "fresh same-factory parent continuation missing")
        assert self.parent["id"] != prior["id"]
        current = next(row for row in self.snapshot()["runs"] if row["id"] == self.parent["id"])
        assert current["context_id"] == old["context_id"]
        assert current["incarnation_id"] == old["incarnation_id"]
        assert current["session_id"] == old["session_id"]
        assert current["native_session_id"] == old["native_session_id"]
        assert current["message_id"] == message["message_id"]
        ordinary.wait_for(lambda: self.task_list()["can_create"], "resumed parent task gate missing")
        return message

    def refence_machine(self):
        # Fault injection only in this newly created synthetic DB. Advancing the
        # generation revokes the old context; it never creates a new credential.
        path = (self.home / "core.sqlite3").resolve(strict=True)
        assert path.parent == self.home.resolve(strict=True)
        with sqlite3.connect(path) as db:
            changed = db.execute("UPDATE production_supervisors SET generation=generation+1").rowcount
            assert changed == 1
