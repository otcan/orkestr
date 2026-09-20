#!/usr/bin/env python3
"""Durable, metadata-only qualification window; never starts live tests.

Input comes from an approved protected collector. A restart, release change,
failed check or sampling gap breaks the window; old evidence is retained.
"""
import argparse
import json
import re
import time

from evidence_archive import canonical, timestamp
from internal_signals import protected_json
from service_audit import AuditStore, token


class Window:
    def __init__(self, store, policy):
        if (not isinstance(policy, dict) or not token(policy.get("window_id")) or not token(policy.get("owner"))
                or not token(policy.get("change_ref")) or type(policy.get("duration_seconds")) is not int
                or not 86400 <= policy["duration_seconds"] <= 604800
                or type(policy.get("max_gap_seconds")) is not int or not 10 <= policy["max_gap_seconds"] <= 300):
            raise ValueError("owned protected window policy required")
        checks = policy.get("checks")
        if not isinstance(checks, list) or not checks or len(checks) > 32 or len(set(checks)) != len(checks) or not all(token(key) for key in checks):
            raise ValueError("explicit distinct qualification checks required")
        store.claim_kind("qualification")
        self.store, self.policy = store, policy
        with store.db:
            store.db.execute("""CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY, stamp REAL NOT NULL, payload TEXT NOT NULL)""")
            store.db.execute("INSERT OR IGNORE INTO state VALUES('qualification_policy',?)", (canonical(policy),))
            if store.db.execute("SELECT value FROM state WHERE key='qualification_policy'").fetchone()[0] != canonical(policy):
                raise ValueError("window policy changed; use a new scoped evidence directory")

    def observe(self, sample):
        if not isinstance(sample, dict):
            raise ValueError("qualification metadata required")
        stamp = timestamp(sample.get("observed_at"))
        if (not token(sample.get("release_id")) or not isinstance(sample.get("boot_id"), str)
                or not re.fullmatch(r"[a-f0-9]{32}", sample["boot_id"])
                or type(sample.get("service_generation")) is not int or sample["service_generation"] < 0):
            raise ValueError("exact release, boot and service-cycle generation required")
        checks, refs = sample.get("checks"), sample.get("evidence_refs")
        if (not isinstance(checks, dict) or set(checks) != set(self.policy["checks"])
                or any(type(value) is not bool for value in checks.values())
                or not isinstance(refs, dict) or set(refs) != set(checks) or not all(token(value) for value in refs.values())):
            raise ValueError("each check requires literal result and retained evidence reference")
        # An absent/expired dependency exception must be represented as a failed
        # check by its collector. This recorder never manufactures approval.
        row = {key: sample[key] for key in ("observed_at", "release_id", "boot_id", "service_generation", "checks", "evidence_refs")}
        db = self.store.db
        db.execute("BEGIN IMMEDIATE")
        try:
            last = db.execute("SELECT stamp FROM observations ORDER BY id DESC LIMIT 1").fetchone()
            if last and stamp <= last["stamp"]:
                raise ValueError("qualification observation must advance time")
            if db.execute("SELECT count(*) FROM observations").fetchone()[0] >= 10000:
                raise RuntimeError("qualification evidence full; preserve this window before starting another")
            db.execute("INSERT INTO observations(stamp,payload) VALUES(?,?)", (stamp, canonical(row)))
            db.commit()
        except BaseException:
            db.rollback()
            raise

    def report(self, now):
        timestamp(now)
        start, last, identity, breaks, samples = None, None, None, [], 0
        for row in self.store.db.execute("SELECT payload FROM observations ORDER BY id"):
            sample = json.loads(row["payload"])
            stamp = sample["observed_at"]
            current = (sample["release_id"], sample["boot_id"], sample["service_generation"])
            reasons = []
            if last is not None and stamp - last > self.policy["max_gap_seconds"]:
                reasons.append("sampling_gap")
            if identity is not None and current != identity:
                reasons.append("release_boot_or_service_cycle_changed")
            reasons += ["check_failed:" + key for key, value in sample["checks"].items() if not value]
            if reasons:
                breaks.append({"observed_at": stamp, "reasons": reasons})
                start, samples = None, 0
            if all(sample["checks"].values()):
                if start is None:
                    start = stamp
                samples += 1
            last, identity = stamp, current
        fresh = last is not None and 0 <= now - last <= self.policy["max_gap_seconds"]
        span = last - start if start is not None else 0
        return {"window_id": self.policy["window_id"], "complete": fresh and span >= self.policy["duration_seconds"],
                "fresh": fresh, "clean_span_seconds": span, "clean_samples": samples,
                "required_seconds": self.policy["duration_seconds"], "break_count": len(breaks), "breaks": breaks,
                "operational_acceptance_requires_review": True}


def check_dependency(actual, policy, now):
    """Exact baseline/exception match preserves approved mail dependencies.

    Neither an arbitrary active service nor an empty Funnel is assumed safe.
    Funnel routes are non-secret identifiers collected by the approved wrapper.
    """
    from hardening_plan import exception
    if not isinstance(policy, dict) or not UNIT_PATTERN.fullmatch(policy.get("unit", "")):
        raise ValueError("exact dependency unit required")
    exception(policy.get("exception"), now)
    expected = policy.get("expected")
    if (not isinstance(expected, dict) or set(expected) != {"active", "enabled", "funnel_routes"}
            or type(expected["active"]) is not bool or type(expected["enabled"]) is not bool
            or not isinstance(expected["funnel_routes"], list) or not all(token(v) for v in expected["funnel_routes"])
            or len(set(expected["funnel_routes"])) != len(expected["funnel_routes"])):
        raise ValueError("exact approved service/exposure baseline required")
    return (isinstance(actual, dict) and actual.get("unit") == policy["unit"]
            and type(actual.get("active")) is bool and type(actual.get("enabled")) is bool
            and actual["active"] == expected["active"] and actual["enabled"] == expected["enabled"]
            and isinstance(actual.get("funnel_routes"), list)
            and sorted(actual["funnel_routes"]) == sorted(expected["funnel_routes"]))


UNIT_PATTERN = re.compile(r"[A-Za-z0-9_.@:-]+\.service\Z")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--state-directory", required=True)
    parser.add_argument("--sample", help="approved protected collector metadata, never a synthetic live message")
    args = parser.parse_args()
    store = AuditStore(args.state_directory)
    try:
        window = Window(store, protected_json(args.policy))
        if args.sample:
            sample = protected_json(args.sample)
            observed = timestamp(sample.get("observed_at"))
            if not 0 <= time.time() - observed <= window.policy["max_gap_seconds"]:
                raise ValueError("only fresh collector observations can extend this window")
            window.observe(sample)
        report = window.report(time.time())
        print(json.dumps(report, sort_keys=True))
        return 0 if report["complete"] else 2
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
