#!/usr/bin/env python3
"""External SSH/HTTPS probe and durable incident/recovery transition ledger.

Run only from an approved independent host. No alerts are sent by this CLI.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit

from service_audit import AuditStore, token


def classify(ssh_ok, https_ok, internal=None, now=0, stale_seconds=120):
    if ssh_ok and https_ok:
        return "healthy"
    fresh = (isinstance(internal, dict) and isinstance(internal.get("observed_at"), (int, float))
             and 0 <= now - internal["observed_at"] <= stale_seconds)
    if fresh and internal.get("route_ok") is False:
        return "public_route_drift"
    if fresh and internal.get("resource_pressure") is True:
        return "resource_pressure"
    if ssh_ok and not https_ok:
        return "https_unreachable"
    if https_ok and not ssh_ok:
        return "ssh_unreachable"
    # Failure of two ports does not prove the host is powered off.
    return "public_path_unreachable" if fresh else "host_or_public_path_unreachable"


class Monitor:
    def __init__(self, store, probe_id, fail_after=3, recover_after=2):
        if not token(probe_id) or not 1 <= fail_after <= 10 or not 1 <= recover_after <= 10:
            raise ValueError("invalid monitor policy")
        self.store, self.probe_id = store, probe_id
        self.fail_after, self.recover_after = fail_after, recover_after
        store.claim_kind("reachability")
        store.db.execute("""CREATE TABLE IF NOT EXISTS monitors (
            id TEXT PRIMARY KEY, state TEXT NOT NULL, last_sample REAL NOT NULL)""")
        store.db.commit()

    def observe(self, outcome, now):
        allowed = {"healthy", "public_route_drift", "resource_pressure", "https_unreachable",
                   "ssh_unreachable", "public_path_unreachable", "host_or_public_path_unreachable"}
        if outcome not in allowed:
            raise ValueError("invalid observation")
        db = self.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            row = db.execute("SELECT state,last_sample FROM monitors WHERE id=?", (self.probe_id,)).fetchone()
            state = json.loads(row["state"]) if row else {"active": "healthy", "candidate": None, "count": 0, "sequence": 0}
            if row and now <= row["last_sample"]:
                db.rollback()
                raise ValueError("sample must be newer than prior observation")
            state["count"] = state["count"] + 1 if state["candidate"] == outcome else 1
            state["candidate"] = outcome
            threshold = self.recover_after if outcome == "healthy" else self.fail_after
            if outcome != state["active"] and state["count"] >= threshold:
                count = db.execute("SELECT count(*) FROM events").fetchone()[0]
                if count >= self.store.max_events:
                    raise RuntimeError("audit capacity reached")
                previous = state["active"]
                state["active"] = outcome
                state["sequence"] += 1
                key = hashlib.sha256(f"{self.probe_id}:{state['sequence']}".encode()).hexdigest()
                payload = {"event_id": key, "kind": "reachability", "probe_id": self.probe_id,
                           "state": outcome, "previous": previous, "observed_at": now}
                db.execute("INSERT INTO events(id,payload,created,next_attempt) VALUES(?,?,?,?)",
                           (key, json.dumps(payload, sort_keys=True), now, now))
            db.execute("INSERT OR REPLACE INTO monitors VALUES(?,?,?)", (self.probe_id, json.dumps(state), now))
            db.commit()
            return state
        except BaseException:
            db.rollback()
            raise


def validate_target(kind, target):
    if kind == "ssh":
        if (not isinstance(target, str) or not target or len(target) > 253
                or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:" for c in target)):
            raise ValueError("invalid SSH host")
    elif kind == "https":
        url = urlsplit(target)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("HTTPS target must not contain credentials, query or fragment")
        if url.port not in (None, 443):
            raise ValueError("HTTPS probe is limited to port 443")
    else:
        raise ValueError("unknown probe type")


def probe_child(kind, target):
    validate_target(kind, target)
    if kind == "ssh":
        with socket.create_connection((target, 22), timeout=5):
            return True
    url = urlsplit(target)
    conn = http.client.HTTPSConnection(url.hostname, port=443, timeout=5, context=ssl.create_default_context())
    try:
        conn.request("HEAD", url.path or "/", headers={"User-Agent": "orkestr-reachability/1"})
        response = conn.getresponse()
        # Redirects are not followed. TLS validation and HTTP health both count.
        return 200 <= response.status < 400
    finally:
        conn.close()


def probe(kind, target, runner=subprocess.run):
    validate_target(kind, target)
    try:
        result = runner([sys.executable, str(Path(__file__).resolve()), "--child", kind, target],
                        timeout=8, capture_output=True, check=False,
                        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "--child":
        try:
            return 0 if probe_child(sys.argv[2], sys.argv[3]) else 1
        except Exception:
            return 1  # Do not serialize TLS/network exceptions or target details.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--https-url", required=True)
    parser.add_argument("--probe-id", required=True)
    parser.add_argument("--state-directory", required=True)
    args = parser.parse_args()
    with ThreadPoolExecutor(max_workers=2) as executor:
        ssh = executor.submit(probe, "ssh", args.ssh_host)
        https = executor.submit(probe, "https", args.https_url)
        outcome = classify(ssh.result(), https.result())
    store = AuditStore(args.state_directory)
    try:
        state = Monitor(store, args.probe_id).observe(outcome, time.time())
        print(json.dumps({"observation": outcome, "monitor": state, "dispatch_enabled": False}))
        return 0 if outcome == "healthy" else 2
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
