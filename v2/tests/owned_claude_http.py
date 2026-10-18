"""Ordinary configured HTTP Claude path with actual owned synthetic native I/O."""
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import owned_execution_http as ordinary


class ClaudeCase(ordinary.Case):
    def configure(self, mode):
        provider = self.root / "synthetic-provider"
        shutil.copyfile(Path(__file__).with_name("owned_claude_peer.py"), provider)
        provider.chmod(0o700)
        home, temporary, account = [self.root / name for name in ("native-home", "native-tmp", "account")]
        for path in [home, temporary, account]:
            path.mkdir(mode=0o700)
        config = self.root / "claude-private.json"
        config.write_text(json.dumps({"executable": str(provider), "account": str(account),
            "workspace": str(self.workspace), "home": str(home), "temporary": str(temporary)}))
        config.chmod(0o600)
        launcher = self.root / "claude-launcher"
        launcher.write_text("#!/usr/bin/python3\nimport sys\n"
            f"sys.path.insert(0, {str(ordinary.broker)!r})\nfrom claude_server import main\n"
            f"raise SystemExit(main({str(config)!r}))\n")
        launcher.chmod(0o700)
        token = self.root / "machine.token"
        token.write_text(self.machine)
        token.chmod(0o600)
        value = {"schema_version": 1, "mode": "isolated-acceptance-v1", "provider": "claude",
            "conversation_id": self.conversation, "machine_token_file": str(token),
            "launcher": str(launcher), "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest(),
            "workspace": str(self.workspace), "namespace": "synthetic:claude", "supervisor_key": "synthetic-http"}
        if mode == "budget":
            value["execution_budget"] = {"max_run_ms": 1000}
        execution = self.root / "execution.json"
        execution.write_text(json.dumps(value))
        execution.chmod(0o600)
        (self.workspace / "claude-mode").write_text(mode)

    def rows(self, query):
        self.trace()
        with sqlite3.connect(f"file:{self.home / 'core.sqlite3'}?mode=ro", uri=True) as db:
            return db.execute(query).fetchall()

    def native_ready(self):
        rows = self.rows("SELECT requested_native_id,observed_run_id,observed_event_key FROM production_requested_native")
        return rows if rows else None


def exercise(mode):
    case = ClaudeCase()
    try:
        case.setup()
        case.stop()
        case.configure(mode)
        case.start(configured=True)
        reserved = ordinary.wait_for(case.native_ready, "ACK must reserve unobserved identity")
        assert len(reserved) == 1 and reserved[0][1:] == (None, None)
        assert [row["kind"] for row in case.trace()] == ["spawn", "initialized"]
        assert reserved[0][0] == case.trace()[0]["native"]
        assert case.request(case.path + "/execution")[0] == 204
        assert case.rows("SELECT count(*) FROM production_runs") == [(0,)]
        assert case.request(case.path + "/messages", "POST", {
            "client_message_id": "forbidden-provider", "text": "synthetic", "provider": "claude"})[0] == 400
        assert case.message()[0] == 202
        starting = ordinary.wait_for(lambda: case.phase("starting"), "one consumed first turn")
        ordinary.wait_for(lambda: any(row["kind"] == "turn" for row in case.trace()), "actual native input")
        assert starting["progress"] is None and starting.get("acceptance_candidate") is None
        assert case.rows("SELECT observed_run_id,observed_event_key FROM production_requested_native") == [(None, None)]
        assert case.rows("SELECT count(*) FROM production_observations") == [(0,)]

        if mode == "revoked":
            # Block persistence after the real frame was emitted, then revoke in
            # the same synthetic transaction before Runtime can commit identity.
            with sqlite3.connect(case.home / "core.sqlite3") as db:
                db.execute("BEGIN IMMEDIATE")
                (case.workspace / "release-init").touch()
                ordinary.wait_for(lambda: any(row["kind"] == "init-emitted" for row in case.trace()),
                                  "real init frame emitted under held Store write lock")
                assert db.execute("SELECT observed_run_id FROM production_requested_native").fetchall() == [(None,)]
                assert db.execute("SELECT count(*) FROM production_observations").fetchone() == (0,)
                db.execute("DELETE FROM auth_sessions WHERE token_hash=?", (hashlib.sha256(case.machine.encode()).hexdigest(),))
            ordinary.wait_for(case.peer_gone, "revoked native must be reaped")
            assert case.rows("SELECT observed_run_id,observed_event_key FROM production_requested_native") == [(None, None)]
            assert case.rows("SELECT count(*) FROM production_observations") == [(0,)]
            assert case.phase("starting") is not None
            return

        (case.workspace / "release-init").touch()
        if mode == "wrong-init":
            ordinary.wait_for(case.peer_gone, "foreign native identity must quarantine this child")
            assert case.rows("SELECT observed_run_id,observed_event_key FROM production_requested_native") == [(None, None)]
            assert case.rows("SELECT count(*) FROM production_observations") == [(0,)]
            assert case.phase("starting") is not None
            return

        running = ordinary.wait_for(lambda: case.phase("running"), "matching init must precede Started")
        observed = case.rows("SELECT observed_run_id,observed_event_key FROM production_requested_native")
        assert observed[0][0] == running["run_id"] and observed[0][1]
        assert running["capabilities"] == {"stop": False, "steer": False}
        intent = {"run_id": running["run_id"], "expected_revision": running["revision"],
                  "expected_control_revision": running["control_revision"], "request_key": "unsupported-stop"}
        assert case.request(case.path + "/stop", "POST", intent)[0] == 503
        assert case.rows("SELECT count(*) FROM production_cancellations") == [(0,)]
        if mode == "budget":
            ordinary.wait_for(case.peer_gone, "budget must fence and clean the owned native")
            cancelled = ordinary.wait_for(lambda: case.phase("cancel_requested"), "budget remains truthful unknown")
            assert cancelled.get("acceptance_candidate") is None
            assert case.rows("SELECT kind FROM production_observations WHERE kind='stopped'") == []
            return

        assert case.message(2)[0] == 202
        (case.workspace / "release-result").touch()
        proposal = ordinary.wait_for(lambda: case.phase("awaiting_acceptance"), "explicit proposal")
        assert not case.peer_gone()
        assert case.rows("SELECT count(*) FROM production_runs") == [(1,)]
        assert case.rows("SELECT count(*) FROM reasoning_inbox WHERE state='consumed'") == [(1,)]
        code, payload, _ = case.request(case.path + "/payloads/" + proposal["progress"]["payload_id"])
        assert code == 200 and payload["text"] == "Synthetic Claude progress"
        accept = {"run_id": proposal["run_id"],
            "completion_event_id": proposal["acceptance_candidate"]["completion_event_id"],
            "expected_revision": proposal["revision"], "request_key": "synthetic-claude-accept"}
        code, receipt, _ = case.request(case.path + "/accept", "POST", accept)
        assert code == 200 and receipt["outcome"] == "succeeded"
        assert case.request(case.path + "/accept", "POST", accept)[:2] == (200, receipt)
        ordinary.wait_for(case.peer_gone, "accepted first turn must reap before factory exits")
        assert case.phase("completed") is not None
        assert case.rows("SELECT count(*) FROM production_runs") == [(1,)]
        assert case.rows("SELECT count(*) FROM reasoning_inbox WHERE state!='consumed'") == [(1,)]
        assert len([row for row in case.trace() if row["kind"] == "turn"]) == 1
    finally:
        case.cleanup()


if __name__ == "__main__":
    for mode in ["success", "wrong-init", "revoked", "budget"]:
        exercise(mode)
        print("ordinary synthetic Claude HTTP case passed:", mode)
