#!/usr/bin/env python3
"""Collect bounded PID-1 job metadata; no alert transport enabled by default."""
import argparse
import json
import os
import selectors
import subprocess
import time

from service_audit import AuditStore
from service_control import receipts
from systemd_posture import UNIT


FIELDS = "__CURSOR,__REALTIME_TIMESTAMP,_BOOT_ID,_PID,_COMM,UNIT,JOB_TYPE,JOB_ID,JOB_RESULT"


def journal_batch(units, cursor=None, limit=1000, lookback_seconds=600):
    if not units or len(units) > 32 or any(not UNIT.fullmatch(unit) for unit in units):
        raise ValueError("explicit service scope required")
    if not 1 <= limit <= 2000 or not 1 <= lookback_seconds <= 86400:
        raise ValueError("invalid collection bound")
    command = ["/usr/bin/journalctl", "--no-pager", "-o", "json", "--output-fields=" + FIELDS,
               "--after-cursor=" + cursor if cursor else f"--since=-{lookback_seconds}s", "_PID=1", "_COMM=systemd"]
    for unit in units:
        command += ["-u", unit]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    rows, buffer = [], b""
    deadline = time.monotonic() + 10
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("journal_read_timeout")
            if not selector.select(remaining):
                raise RuntimeError("journal_read_timeout")
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                if process.wait(timeout=max(0.01, deadline - time.monotonic())) != 0 or buffer:
                    raise RuntimeError("journal_read_failed_or_cursor_lost")
                return rows
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if len(line) > 65536:
                    raise RuntimeError("journal_record_exceeds_bound")
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("invalid journal record")
                rows.append(row)
                if len(rows) >= limit:
                    # Stop at the FIRST N records, not journalctl's last-N tail.
                    # Resume after the last durably ingested cursor next run.
                    return rows
            if len(buffer) > 65536:
                raise RuntimeError("journal_record_exceeds_bound")
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)
        process.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-directory", required=True)
    parser.add_argument("--unit", action="append", required=True)
    parser.add_argument("--summary-only", action="store_true")
    parser.add_argument("--bootstrap-lookback-seconds", type=int, default=600)
    args = parser.parse_args()
    store = AuditStore(args.state_directory)
    try:
        now = time.time()
        if not args.summary_only:
            rows = journal_batch(args.unit, store.cursor(), lookback_seconds=args.bootstrap_lookback_seconds)
            store.ingest(rows, set(args.unit), now)
            store.reconcile(receipts(store))
        print(json.dumps({**store.summary(now), "dispatch_enabled": False}, sort_keys=True))
        return 2 if store.summary(now)["pending"] else 0
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
