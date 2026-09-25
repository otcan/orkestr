#!/usr/bin/env python3
"""Bounded task-usage evidence. Never chooses or changes a service limit."""
import argparse
import json
import math
import subprocess
import time

from service_audit import AuditStore
from systemd_posture import UNIT

PHASES = {"normal", "startup", "peak", "recovery"}
PROPERTIES = {"Id", "LoadState", "ActiveState", "TasksCurrent", "TasksMax", "MemoryCurrent"}


def read_sample(unit, runner=subprocess.run):
    if not isinstance(unit, str) or not UNIT.fullmatch(unit):
        raise ValueError("invalid service unit")
    try:
        response = runner(["systemctl", "show", unit, "--no-pager", "--property=" + ",".join(sorted(PROPERTIES))],
                          capture_output=True, text=True, timeout=5, check=False,
                          env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        return {"unit": unit, "error": "property_read_failed"}
    if response.returncode or len(response.stdout) > 8192:
        return {"unit": unit, "error": "property_read_failed"}
    actual = dict(line.split("=", 1) for line in response.stdout.splitlines()
                  if "=" in line and line.split("=", 1)[0] in PROPERTIES)
    if actual.get("Id") != unit or actual.get("LoadState") != "loaded" or actual.get("ActiveState") != "active":
        return {"unit": unit, "error": "unit_unavailable"}
    try:
        tasks = int(actual["TasksCurrent"])
        maximum = None if actual.get("TasksMax") == "infinity" else int(actual["TasksMax"])
        memory = int(actual["MemoryCurrent"])
        if tasks < 0 or memory < 0 or (maximum is not None and maximum < 1):
            raise ValueError()
    except (KeyError, ValueError):
        return {"unit": unit, "error": "counts_unavailable"}
    return {"unit": unit, "tasks": tasks, "configured_max": maximum, "memory_bytes": memory}


class Baseline:
    def __init__(self, directory, units, capacity=10000):
        if (not isinstance(units, list) or not 1 <= len(units) <= 32 or len(set(units)) != len(units)
                or any(not isinstance(unit, str) or not UNIT.fullmatch(unit) for unit in units)
                or not isinstance(capacity, int) or isinstance(capacity, bool) or not 1 <= capacity <= 100000):
            raise ValueError("bounded explicit service scope required")
        self.units, self.capacity = sorted(units), capacity
        self.store = AuditStore(directory)
        try:
            self.store.claim_kind("task-baseline")
            with self.store.db:
                scope = json.dumps(self.units)
                self.store.db.execute("INSERT OR IGNORE INTO state VALUES('units',?)", (scope,))
                if self.store.db.execute("SELECT value FROM state WHERE key='units'").fetchone()[0] != scope:
                    raise ValueError("baseline scope changed; use a separate evidence directory")
                self.store.db.execute("CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, time REAL NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL)")
        except BaseException:
            self.store.close()
            raise

    def close(self):
        self.store.close()

    def collect(self, phase, now=None, runner=subprocess.run):
        if phase not in PHASES:
            raise ValueError("explicit workload phase required")
        observed = time.time() if now is None else now
        if type(observed) not in (float, int) or not math.isfinite(observed) or observed < 0:
            raise ValueError("invalid sample time")
        # Capture errors as missing evidence, never a zero task count.
        rows = [read_sample(unit, runner) for unit in self.units]
        db = self.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            latest = db.execute("SELECT max(time) FROM samples").fetchone()[0]
            if latest is not None and observed <= latest:
                raise ValueError("baseline observation must advance time")
            if db.execute("SELECT count(*) FROM samples").fetchone()[0] + len(rows) > self.capacity:
                raise RuntimeError("baseline capacity reached; preserve/export evidence before a new window")
            for row in rows:
                db.execute("INSERT INTO samples(time,phase,payload) VALUES(?,?,?)", (observed, phase, json.dumps(row, sort_keys=True)))
            db.commit()
        except BaseException:
            db.rollback()
            raise
        return rows

    def report(self):
        result = []
        rows = [(row["time"], row["phase"], json.loads(row["payload"])) for row in
                self.store.db.execute("SELECT time,phase,payload FROM samples ORDER BY time,id")]
        for unit in self.units:
            samples = [(stamp, phase, row) for stamp, phase, row in rows if row["unit"] == unit]
            valid = [(stamp, phase, row) for stamp, phase, row in samples if "tasks" in row]
            counts = sorted(row["tasks"] for _, _, row in valid)
            times = [stamp for stamp, _, _ in valid]
            result.append({"unit": unit, "sample_count": len(samples), "valid_count": len(valid),
                           "failed_count": len(samples) - len(valid), "observed_peak": max(counts) if counts else None,
                           "p95": counts[math.ceil(len(counts) * .95) - 1] if counts else None,
                           "span_seconds": times[-1] - times[0] if times else 0,
                           "largest_gap_seconds": max((b-a for a, b in zip(times, times[1:])), default=None),
                           "phase_counts": {phase: sum(p == phase for _, p, _ in valid) for phase in sorted(PHASES)},
                           "missing_phases": sorted(PHASES - {phase for _, phase, _ in valid})})
        # Even all four labels are not proof of representative workload coverage.
        return {"services": result, "limit_recommendation": None, "operator_review_required": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-directory", required=True)
    parser.add_argument("--unit", action="append", required=True)
    parser.add_argument("--phase", choices=sorted(PHASES), help="collect one explicitly labelled observation")
    args = parser.parse_args()
    baseline = Baseline(args.state_directory, args.unit)
    try:
        if args.phase:
            baseline.collect(args.phase)
        report = baseline.report()
        print(json.dumps(report, sort_keys=True))
        return 2 if any(row["failed_count"] for row in report["services"]) else 0
    finally:
        baseline.close()


if __name__ == "__main__":
    raise SystemExit(main())
