"""Natural-time ordinary durable timer process acceptance; synthetic state only."""
import hashlib
import json
import os
import select
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
import owned_execution_http as ordinary


class TimerCase(ordinary.Case):
    def start(self):
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin",
                       "ORKESTR_V2_HOME": str(self.home),
                       "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}",
                       "ORKESTR_V2_ORIGIN": self.origin,
                       "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap,
                       "ORKESTR_V2_TIMER_CONFIG": str(self.root / "timer.json")}
        self.process = subprocess.Popen([str(ordinary.binary)], env=environment,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        expected = (f"orkestr-v2-server schema=1 home={self.home} "
                    f"bind=127.0.0.1:{self.port} execution=").encode()
        pending = bytearray()
        def ready():
            if self.process.poll() is not None:
                raise AssertionError("timer startup refused: " + self.process.stderr.read(16384))
            if not select.select([self.process.stderr], [], [], 0.05)[0]:
                return False
            pending.extend(os.read(self.process.stderr.fileno(), 8192))
            assert len(pending) <= 16384
            return any(line.startswith(expected) and line.endswith(b" connections=none")
                       for line in pending.split(b"\n")[:-1])
        ordinary.wait_for(ready, "exact timer child listener readiness")


def migration_inventory(connection):
    return connection.execute(
        "SELECT version, lower(hex(checksum)), success FROM _sqlx_migrations ORDER BY version"
    ).fetchall()


def canonical_migrations():
    migrations = Path(__file__).resolve().parents[1] / "crates/store-sqlite/migrations"
    return sorted((int(path.name.split("_", 1)[0]),
                   hashlib.sha384(path.read_bytes()).hexdigest(), 1)
                  for path in migrations.glob("*.sql"))


def main():
    expected_migrations = canonical_migrations()
    assert expected_migrations, "canonical migration source inventory is empty"
    case = TimerCase()
    seed, conversation, once, interval, disabled, revoked = sys.argv[2:]
    with sqlite3.connect(f"file:{Path(seed)}?mode=ro", uri=True) as source:
        assert migration_inventory(source) == expected_migrations, "seed migration inventory/checksums differ from source"
        with sqlite3.connect(case.home / "core.sqlite3") as target:
            source.backup(target)
    case.conversation = conversation
    case.path = f"/api/v2/conversations/{conversation}"
    case.machine = "a1" * 32
    browser = "b2" * 32
    case.cookie = f"orkestr_v2_session={browser}"
    case.csrf = hashlib.sha256(f"orkestr-v2-browser-csrf-v1:{browser}".encode()).hexdigest()
    token_file = case.root / "machine.token"
    token_file.write_text(case.machine)
    token_file.chmod(0o600)
    config = case.root / "timer.json"
    config.write_text(json.dumps({"schema_version": 1, "machine_token_file": str(token_file)}))
    config.chmod(0o600)
    path = lambda namespace: f"/api/v2/timers/{namespace}"
    enable = lambda key: {"expected_revision": 1, "request_key": key,
                          "conversation_id": conversation, "text": "Synthetic scheduled owner input"}
    def db_rows(sql):
        with sqlite3.connect(f"file:{case.home / 'core.sqlite3'}?mode=ro", uri=True) as db:
            return db.execute(sql).fetchall()
    def ledger():
        return db_rows("SELECT * FROM dormant_timer_inputs ORDER BY owner_id,namespace,generation,claim_id")
    def detail(namespace):
        code, result, _ = case.request(path(namespace), browser=False,
                                      extra={"Authorization": f"Bearer {case.machine}"})
        assert code == 200
        return result
    def assert_inert_provider():
        assert db_rows("SELECT count(*) FROM production_runs") == [(0,)]
        assert db_rows("SELECT count(*) FROM outbox WHERE state='delivered'") == [(0,)]
        assert not (case.home / "owned-execution").exists()
    try:
        case.start()
        assert case.request(path(once), browser=False)[0] == 401
        code, paused, headers = case.request(path(once))
        assert code == 200 and paused["state"] == "paused" and not paused["controller_armed"]
        assert headers["Cache-Control"] == "no-store"
        assert case.request(path(once) + "?now_ms=0")[0] == 400
        body = enable("once")
        for extra in [{"x-orkestr-csrf": "wrong"}, {"Origin": "http://fake.invalid"},
                      {"Authorization": f"Bearer {case.machine}"}]:
            assert case.request(path(once) + "/enable", "POST", body, extra=extra)[0] in (401, 403)
        assert case.request(path(once) + "/enable", "POST", dict(body, now_ms=0))[0] == 400
        assert case.request(path(once) + "/enable", "POST", body)[1]["controller_armed"]
        interval_body = enable("weekly")
        code, armed, _ = case.request(path(interval) + "/enable", "POST", interval_body)
        assert code == 200 and armed["controller_armed"]
        assert armed["next_due_ms"] > time.time() * 1000 + 6 * 86_400_000
        disable_body = enable("disabled-once")
        code, before, _ = case.request(path(disabled) + "/enable", "POST", disable_body)
        assert code == 200
        control = {"expected_revision": before["revision"], "request_key": "disable", "action": "disable"}
        code, off, _ = case.request(path(disabled) + "/control", "POST", control)
        assert code == 200 and not off["controller_armed"]
        assert case.request(path(revoked) + "/enable", "POST", enable("revoke-before-due"))[0] == 200
        assert case.request("/api/v2/browser/session", "DELETE")[0] == 204
        assert case.request(path(interval))[0] == 401
        ordinary.wait_for(lambda: detail(once)["state"] == "exhausted",
                          "due intake survives creator logout", seconds=12)
        grant_rows = db_rows("SELECT * FROM durable_timer_authorities ORDER BY namespace,generation")
        committed = ledger()
        assert len(committed) == 1
        assert db_rows("SELECT count(*) FROM messages") == [(1,)]
        assert_inert_provider()
        # Clean process restart recreates trusted issuer but retains exact immutable grant.
        process = case.process
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=6)
        process.stderr.close()
        case.process = None
        assert process.returncode == 0
        case.start()
        resumed = detail(interval)
        assert resumed["controller_armed"] and resumed["generation"] == armed["generation"]
        assert resumed["next_due_ms"] == armed["next_due_ms"]
        # Use current machine auth, never resurrect the logged-out creator cookie.
        auth = {"Authorization": f"Bearer {case.machine}"}
        code, retry, _ = case.request(path(disabled) + "/enable", "POST", disable_body,
                                      browser=False, extra=auth)
        assert code == 200 and retry["state"] == "disabled" and not retry["controller_armed"]
        assert retry["revision"] == off["revision"]
        code, changed, _ = case.request(path(interval) + "/enable", "POST",
                                       dict(interval_body, text="Changed synthetic instruction"),
                                       browser=False, extra=auth)
        assert code == 409
        # Actual SIGKILL after committed intake, then new exec: no duplicate occurrence.
        case.process.kill()
        case.process.wait(timeout=3)
        case.process.stderr.close()
        case.process = None
        # A killed live supervisor cannot be stolen: wait for its real DB lease.
        deadline = db_rows("SELECT lease_deadline_ms FROM production_supervisors WHERE namespace='orkestr:durable-timers'")[0][0]
        while time.time() * 1000 <= deadline:
            time.sleep(min(0.5, (deadline - time.time() * 1000) / 1000 + 0.01))
        case.start()
        assert ledger() == committed
        assert db_rows("SELECT * FROM durable_timer_authorities ORDER BY namespace,generation") == grant_rows
        assert detail(interval)["controller_armed"]
        case.revoke_machine()  # controlled synthetic auth fence, no production database
        ordinary.wait_for(lambda: case.process.poll() is not None,
                          "machine revoke must stop scheduler and ordinary server", seconds=5)
        assert case.process.returncode != 0
        assert ledger() == committed
        assert_inert_provider()
        assert db_rows("SELECT count(*) FROM durable_timer_authorities") == [(4,)]
        actual_migrations = db_rows("SELECT version, lower(hex(checksum)), success FROM _sqlx_migrations ORDER BY version")
        assert actual_migrations == expected_migrations, "final migration inventory/checksums differ from source"
        assert db_rows("PRAGMA foreign_key_check") == []
        print(json.dumps({"result": "PASS", "binary_sha256": hashlib.sha256(ordinary.binary.read_bytes()).hexdigest(),
                          "schema": actual_migrations[-1][0], "migration_count": len(actual_migrations), "intakes": 1, "native_runs": 0,
                          "checks": ["cookie-origin-csrf", "natural-due", "creator-logout", "weekly-restart",
                                     "disable-before-due", "historical-retry-inert", "changed-retry-refused",
                                     "sigkill-new-exec-no-duplicate", "machine-revoke-fails-closed"]}))
    finally:
        case.cleanup()


if __name__ == "__main__":
    main()
