"""Bounded actual binary timer lifecycle; no provider or external transport."""
import hashlib
import shutil
import sqlite3
import sys
from pathlib import Path
import owned_execution_http as ordinary


def main():
    case = ordinary.Case()
    seed, conversation, once, interval = sys.argv[2:]
    shutil.copyfile(Path(seed), case.home / "core.sqlite3")
    case.conversation = conversation
    case.path = f"/api/v2/conversations/{conversation}"
    case.machine = "a1" * 32
    browser = "b2" * 32
    case.cookie = f"orkestr_v2_session={browser}"
    case.csrf = hashlib.sha256(f"orkestr-v2-browser-csrf-v1:{browser}".encode()).hexdigest()
    path = lambda namespace: f"/api/v2/timers/{namespace}"
    enable = lambda key: {"expected_revision": 1, "request_key": key,
                          "conversation_id": conversation, "text": "Synthetic scheduled owner input"}
    try:
        case.start()
        assert case.request(path(once), browser=False)[0] == 401
        code, paused, headers = case.request(path(once))
        assert code == 200 and paused["state"] == "paused" and not paused["controller_armed"]
        assert headers["Cache-Control"] == "no-store"
        assert case.request(path(once) + "?now_ms=0")[0] == 400
        body = enable("once")
        assert case.request(path(once) + "/enable", "POST", body,
                            extra={"x-orkestr-csrf": "wrong"})[0] == 403
        assert case.request(path(once) + "/enable", "POST", dict(body, credential="forbidden"))[0] == 400
        assert case.request(path(once) + "/enable", "POST", body)[1]["controller_armed"]
        interval_body = enable("interval")
        code, armed, _ = case.request(path(interval) + "/enable", "POST", interval_body)
        assert code == 200 and armed["controller_armed"]
        def delivered():
            code, result, _ = case.request(path(once))
            return code == 200 and result["state"] == "exhausted"
        ordinary.wait_for(delivered, "ordinary controller must deliver the due input", seconds=12)
        with sqlite3.connect(f"file:{case.home / 'core.sqlite3'}?mode=ro", uri=True) as db:
            assert db.execute("SELECT count(*) FROM dormant_timer_inputs").fetchone() == (1,)
            assert db.execute("SELECT count(*) FROM messages").fetchone() == (1,)
            assert db.execute("SELECT count(*) FROM production_runs").fetchone() == (0,)
        process = case.process
        case.stop()
        assert process.returncode == 0, "ordinary shutdown must join the timer controller"
        case.start()
        code, resumed, _ = case.request(path(interval))
        assert code == 200 and resumed["state"] == "enabled"
        assert not resumed["controller_armed"]
        assert resumed["controller_hold"] == "explicit_owner_rearm_required"
        code, duplicate, _ = case.request(path(interval) + "/enable", "POST", interval_body)
        assert code == 200 and not duplicate["controller_armed"]
        assert duplicate["revision"] == armed["revision"]
        control = {"expected_revision": duplicate["revision"], "request_key": "disable",
                   "action": "disable"}
        code, disabled, _ = case.request(path(interval) + "/control", "POST", control)
        assert code == 200 and disabled["state"] == "disabled"
        fresh = dict(interval_body, expected_revision=disabled["revision"], request_key="fresh")
        assert case.request(path(interval) + "/enable", "POST", fresh)[1]["controller_armed"]
        assert case.request(case.path + "/execution")[0] == 204
        assert not (case.home / "owned-execution").exists()
    finally:
        case.cleanup()


if __name__ == "__main__":
    main()
