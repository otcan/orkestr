"""A running synthetic turn keeps its native child through a held Core write lock.

Another writer holding SQLite past busy_timeout makes the supervisor heartbeat
and the run-lease renewal fail transiently. The window must defer both and keep
the same native child, then renew once the lock clears."""
import sqlite3
import subprocess
import sys
import time


def _lease(case, run_id):
    db = sqlite3.connect(f"file:{case.home / 'core.sqlite3'}?mode=ro", uri=True, timeout=5)
    try:
        return db.execute("SELECT lease_deadline_ms FROM production_runs WHERE id=?",
                          (run_id,)).fetchone()[0]
    finally:
        db.close()


def held_write_lock(case, wait_for):
    from owned_execution_followup import proposal
    case.stop()
    case.configure()
    for name in ("hold-first", "hold-first-long"):
        (case.workspace / name).touch()
    case.start(configured=True)
    assert case.message()[0] == 202
    run = wait_for(lambda: case.phase("running"), "first synthetic turn must be active")["run_id"]
    time.sleep(1.5)  # the turn's own setup writes finish before the lock
    before = _lease(case, run)
    held = case.root / "write-lock-held"
    holder = subprocess.Popen([sys.executable, "-c",
        "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], isolation_level=None, timeout=5); "
        "c.execute('BEGIN EXCLUSIVE'); open(sys.argv[2],'w').write('held'); time.sleep(600)",
        str(case.home / "core.sqlite3"), str(held)])
    try:
        wait_for(held.exists, "test write lock must be held")
        # Two heartbeat intervals and the first run-lease refresh fall inside.
        time.sleep(22)
        assert not case.peer_gone(), "a held write lock must not reap the running native child"
        status = case.phase("running")
        assert status and status["run_id"] == run, "the run must still be running"
    finally:
        holder.kill()
        holder.wait()
    wait_for(lambda: _lease(case, run) > before, "the run lease must advance once the lock clears",
             seconds=20)
    assert case.phase("running")["run_id"] == run
    assert not case.peer_gone()
    (case.workspace / "release-first").touch()
    proposal(case, wait_for)
    assert not case.peer_gone()
