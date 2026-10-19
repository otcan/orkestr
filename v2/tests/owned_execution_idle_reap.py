"""Strict PID disappearance while ordinary HTTP stays live; synthetic only."""
import os
from pathlib import Path
import signal
import sqlite3
import sys
import time

from owned_execution_http import Case, wait_for
from owned_execution_followup import accept, proposal
from owned_native_probe import descendants, process_start


def ledger(case):
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        return {name:db.execute(query).fetchall() for name, query in {
            "bindings":"SELECT id,generation,state,native_session_id FROM session_bindings ORDER BY id",
            "runs":"SELECT id,state,attempt,session_id,native_session_id,message_id FROM production_runs ORDER BY id",
            "observations":"SELECT run_id,kind,count(*) FROM production_observations GROUP BY run_id,kind ORDER BY run_id,kind",
            "acceptances":"SELECT count(*) FROM production_acceptances",
            "cancellations":"SELECT count(*) FROM production_cancellations",
            "retirements":"SELECT count(*) FROM production_graceful_retirements",
            "resume":"SELECT count(*) FROM production_resume_metadata",
        }.items()}


def durable_ready(case):
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        return db.execute("SELECT count(*) FROM session_bindings WHERE role='deep' AND state='ready'").fetchone() == (1,)


def exercise(phase):
    case = Case()
    try:
        case.setup();case.stop();case.configure();case.start(configured=True)
        wait_for(lambda:any(row["kind"] == "ready" for row in case.trace()), "native setup readiness")
        # The peer records ready before emitting its reply. Kill only after the
        # ordinary server has committed that reply, not during setup's transition.
        wait_for(lambda:durable_ready(case), "durable idle Ready binding")
        if phase != "ready":
            assert case.message()[0] == 202
            status = proposal(case, wait_for)
            if phase == "completed":
                accept(case, status, 1)
                wait_for(lambda:case.phase("completed"), "explicit owner acceptance")
        before = ledger(case)
        launcher = str(case.root / "synthetic-launcher").encode()
        owned = {pid:process_start(pid) for pid in descendants(case.process.pid)}
        brokers = []
        for pid, start in owned.items():
            try:
                argv = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
                if launcher in argv[:2]:brokers.append((pid, start))
            except FileNotFoundError:
                pass
        assert len(brokers) == 1 and owned, "one owned fixed broker is required"
        pid, start = brokers[0]
        descriptor = os.pidfd_open(pid)
        try:
            assert process_start(pid) == start and pid in descendants(case.process.pid)
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        finally:
            os.close(descriptor)
        began = time.monotonic()
        # Includes broker zombies: the ordinary parent must reap while alive.
        wait_for(lambda:all(process_start(pid) != start for pid,start in owned.items()),
                 "all exact owned identities must disappear without server shutdown", 3)
        assert case.process.poll() is None and case.request('/api/v2/health', browser=False)[0] == 200
        after = ledger(case)
        assert after == before, ("local cleanup cannot create Stopped/acceptance/resume authority", phase,
            {key:{"before":before[key],"after":after[key]} for key in before if before[key] != after[key]})
        assert case.message(2)[0] == 202
        # Keep HTTP responsive long enough to exercise the next admission polls.
        end = time.monotonic() + .35
        while time.monotonic() < end:
            assert case.process.poll() is None
            assert ledger(case) == before, "lost broker must never admit a successor run"
            time.sleep(.025)
        assert not descendants(case.process.pid), "cleanup cannot create a replacement broker"
        print(f"idle {phase}: all owned identities gone in {time.monotonic()-began:.3f}s; ledger unchanged", flush=True)
    finally:
        case.cleanup()


if __name__ == '__main__':
    phases = sys.argv[2:] or ['ready', 'awaiting_acceptance', 'completed']
    assert set(phases) <= {'ready','awaiting_acceptance','completed'}
    for phase in phases:exercise(phase)
