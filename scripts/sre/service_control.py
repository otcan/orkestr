#!/usr/bin/env python3
"""Explicit, allowlisted systemd control with exact returned-job evidence.

Not installed or activated automatically. Requires a private root-owned policy,
--apply and a change reference. Never falls back to an unattributed systemctl.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

from service_audit import AuditStore, token


METHODS = {"start": "StartUnit", "stop": "StopUnit", "restart": "RestartUnit",
           "reload": "ReloadUnit", "try-restart": "TryRestartUnit"}


def initialize(store):
    store.claim_kind("service-control")
    store.db.execute("""CREATE TABLE IF NOT EXISTS controls (
        operation_id TEXT PRIMARY KEY, principal TEXT NOT NULL, change_ref TEXT NOT NULL,
        source TEXT NOT NULL, boot_id TEXT NOT NULL, unit TEXT NOT NULL, action TEXT NOT NULL,
        outcome TEXT NOT NULL, job_id TEXT, created REAL NOT NULL)""")
    store.db.commit()


def control(store, unit, action, change_ref, boot_id, allowed_units, runner=subprocess.run):
    if unit not in allowed_units or not token(unit) or action not in METHODS or not token(change_ref):
        raise ValueError("unit, action or change reference not approved")
    if not re.fullmatch(r"[a-f0-9]{32}", boot_id):
        raise ValueError("invalid boot identity")
    initialize(store)
    operation_id = str(uuid.uuid4())
    with store.db:
        store.db.execute("INSERT INTO controls VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (operation_id, f"uid:{os.getuid()}", change_ref, "service-control",
                          boot_id, unit, action, "intent", None, time.time()))
    outcome, job_id = "uncertain", None
    try:
        result = runner(["/usr/bin/busctl", "--system", "--json=short", "--timeout=5s", "call",
                         "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                         "org.freedesktop.systemd1.Manager", METHODS[action], "ss", unit, "replace"],
                        capture_output=True, text=True, timeout=7, check=False,
                        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        if result.returncode == 0:
            payload = json.loads(result.stdout)
            values = payload.get("data")
            if payload.get("type") == "o" and isinstance(values, list) and len(values) == 1 and isinstance(values[0], str):
                match = re.fullmatch(r"/org/freedesktop/systemd1/job/([0-9]{1,20})", values[0])
                if match:
                    job_id, outcome = match[1], "accepted"
    except (subprocess.SubprocessError, OSError, ValueError, AttributeError):
        pass
    with store.db:
        store.db.execute("UPDATE controls SET outcome=?,job_id=? WHERE operation_id=?", (outcome, job_id, operation_id))
    # Accepted means systemd accepted a job, NOT that the service is healthy.
    return {"operation_id": operation_id, "outcome": outcome, "job_id": job_id}


def receipts(store):
    initialize(store)
    return [dict(row) for row in store.db.execute("""SELECT operation_id,principal,change_ref,source,
        boot_id,unit,action,outcome,job_id FROM controls WHERE outcome='accepted'""")]


def read_policy(path):
    candidate = Path(path)
    for part in [candidate, *candidate.parents]:
        metadata = part.lstat()
        if metadata.st_uid != 0 or stat.S_ISLNK(metadata.st_mode) or metadata.st_mode & 0o022:
            raise ValueError("policy and parents must be root owned and protected; symlinks forbidden")
    with candidate.open(encoding="utf-8") as handle:
        policy = json.load(handle)
    units = policy.get("units")
    if not isinstance(units, list) or not units or any(not token(unit) for unit in units):
        raise ValueError("explicit unit allowlist required")
    return policy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=METHODS)
    parser.add_argument("unit")
    parser.add_argument("--policy", required=True)
    parser.add_argument("--change-ref", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply or os.geteuid() != 0:
        parser.error("explicit --apply and privileged operator context required")
    policy = read_policy(os.path.abspath(args.policy))
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip().replace("-", "")
    store = AuditStore(policy["stateDirectory"])
    try:
        result = control(store, args.unit, args.action, args.change_ref, boot, policy["units"])
        print(json.dumps(result))
        return 0 if result["outcome"] == "accepted" else 2
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
