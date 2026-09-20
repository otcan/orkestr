#!/usr/bin/env python3
"""External SSH/HTTPS probe and durable incident/recovery transition ledger.

Run only from an approved independent host. No alerts are sent by this CLI.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import math
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit

from service_audit import AuditStore, token
from internal_signals import load_signal


def classify(ssh_ok, https_ok, internal=None, now=0, stale_seconds=120):
    fresh = (isinstance(internal, dict) and isinstance(internal.get("observed_at"), (int, float))
             and 0 <= now - internal["observed_at"] <= stale_seconds)
    if fresh and internal.get("route_ok") is False:
        return "public_route_drift"
    if fresh and internal.get("resource_pressure") is True:
        return "resource_pressure"
    if ssh_ok and https_ok:
        return "healthy"
    if ssh_ok and not https_ok:
        return "https_unreachable"
    if https_ok and not ssh_ok:
        return "ssh_unreachable"
    # Failure of two ports does not prove the host is powered off.
    return "public_path_unreachable" if fresh else "host_or_public_path_unreachable"


class Monitor:
    def __init__(self, store, probe_id, fail_after=3, recover_after=2, max_gap_seconds=180, targets=None, internal_source=None):
        if (not token(probe_id) or any(not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 10
                                       for value in (fail_after, recover_after))
                or not isinstance(max_gap_seconds, (int, float)) or isinstance(max_gap_seconds, bool)
                or not math.isfinite(max_gap_seconds) or not 1 <= max_gap_seconds <= 3600):
            raise ValueError("invalid monitor policy")
        if targets is not None:
            if not isinstance(targets, dict) or set(targets) != {"ssh", "https"}:
                raise ValueError("both explicit probe targets required")
            for kind, target in targets.items():
                validate_target(kind, target)
        self.store, self.probe_id = store, probe_id
        self.fail_after, self.recover_after = fail_after, recover_after
        self.max_gap_seconds = max_gap_seconds
        store.claim_kind("reachability")
        store.db.execute("""CREATE TABLE IF NOT EXISTS monitors (
            id TEXT PRIMARY KEY, state TEXT NOT NULL, last_sample REAL NOT NULL)""")
        store.db.commit()
        # Policy/target changes must not reuse the old incident history. Bind
        # before probing, including when the database has no samples yet.
        binding = {"targets": targets, "fail_after": fail_after,
                   "recover_after": recover_after, "max_gap_seconds": max_gap_seconds}
        if internal_source is not None:
            if (not isinstance(internal_source, dict) or set(internal_source) != {"source_id", "policy_digest"}
                    or not token(internal_source["source_id"]) or not isinstance(internal_source["policy_digest"], str)
                    or len(internal_source["policy_digest"]) != 64
                    or any(c not in "0123456789abcdef" for c in internal_source["policy_digest"])):
                raise ValueError("invalid internal telemetry binding")
            binding["internal_source"] = internal_source
        policy = json.dumps(binding, sort_keys=True)
        key = "probe_policy:" + probe_id
        with store.db:
            existing = store.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
            if existing and existing[0] != policy:
                raise ValueError("monitor policy changed; use a new reviewed probe identity")
            if not existing:
                if store.db.execute("SELECT 1 FROM monitors WHERE id=?", (probe_id,)).fetchone():
                    raise ValueError("unbound legacy monitor; reconcile before using a new probe identity")
                store.db.execute("INSERT INTO state VALUES(?,?)", (key, policy))

    def observe(self, outcome, now):
        allowed = {"healthy", "public_route_drift", "resource_pressure", "https_unreachable",
                   "ssh_unreachable", "public_path_unreachable", "host_or_public_path_unreachable", "internal_signal_unavailable"}
        if (outcome not in allowed or not isinstance(now, (int, float)) or isinstance(now, bool)
                or not math.isfinite(now) or now < 0):
            raise ValueError("invalid observation")
        db = self.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            row = db.execute("SELECT state,last_sample FROM monitors WHERE id=?", (self.probe_id,)).fetchone()
            state = json.loads(row["state"]) if row else {"active": "healthy", "candidate": None, "count": 0, "sequence": 0}
            if row and now <= row["last_sample"]:
                db.rollback()
                raise ValueError("sample must be newer than prior observation")
            if row and now - row["last_sample"] > self.max_gap_seconds:
                # A monitoring gap is not recovery, nor consecutive evidence.
                state.update(candidate=None, count=0, failure_count=0)
            state["count"] = state["count"] + 1 if state["candidate"] == outcome else 1
            state["candidate"] = outcome
            state["failure_count"] = 0 if outcome == "healthy" else state.get("failure_count", 0) + 1
            threshold = self.recover_after if outcome == "healthy" else self.fail_after
            evidence_count = state["failure_count"] if state["active"] == "healthy" and outcome != "healthy" else state["count"]
            if outcome != state["active"] and evidence_count >= threshold:
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
    if not isinstance(target, str):
        raise ValueError("probe target must be a string")
    if kind == "ssh":
        if (not isinstance(target, str) or not target or len(target) > 253
                or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:" for c in target)):
            raise ValueError("invalid SSH host")
    elif kind == "https":
        url = urlsplit(target)
        if (not isinstance(target, str) or len(target) > 2048 or any(ord(c) < 33 or ord(c) == 127 for c in target)
                or url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment):
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
    parser.add_argument("--internal-signal", help="protected file delivered by an approved authenticated collector")
    parser.add_argument("--signal-source")
    parser.add_argument("--signal-policy-digest")
    args = parser.parse_args()
    signal_options = [args.internal_signal, args.signal_source, args.signal_policy_digest]
    if any(signal_options) and not all(signal_options):
        parser.error("internal signal requires source identity and reviewed policy digest")
    internal_source = {"source_id": args.signal_source, "policy_digest": args.signal_policy_digest} if args.internal_signal else None
    store = AuditStore(args.state_directory)
    try:
        monitor = Monitor(store, args.probe_id, targets={"ssh": args.ssh_host, "https": args.https_url}, internal_source=internal_source)
        with ThreadPoolExecutor(max_workers=2) as executor:
            ssh = executor.submit(probe, "ssh", args.ssh_host)
            https = executor.submit(probe, "https", args.https_url)
            ssh_ok, https_ok = ssh.result(), https.result()
        now, internal, signal_state = time.time(), None, "not_configured"
        if args.internal_signal:
            try:
                internal = load_signal(args.internal_signal, args.signal_source, args.signal_policy_digest, now)
                signal_state = "fresh"
            except (OSError, ValueError):
                signal_state = "unavailable_or_untrusted"
        outcome = classify(ssh_ok, https_ok, internal, now)
        if outcome == "healthy" and signal_state == "unavailable_or_untrusted":
            # Public success cannot prove recovery from internal pressure/route
            # incidents while their configured trusted feed is unavailable.
            outcome = "internal_signal_unavailable"
        state = monitor.observe(outcome, now)
        print(json.dumps({"observation": outcome, "monitor": state, "internal_signal": signal_state, "dispatch_enabled": False}))
        return 0 if outcome == "healthy" and signal_state != "unavailable_or_untrusted" else 2
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
