#!/usr/bin/env python3
"""Compile reviewed service profiles to bounded drop-in/rollback artifacts.

Prints candidates only. Never installs files, reloads systemd or restarts units.
"""
import argparse
import hashlib
import json
import math
from pathlib import PurePosixPath
import re
import time

from evidence_archive import digest, timestamp
from internal_signals import protected_json
from service_audit import token
from systemd_posture import UNIT
from task_baseline import PHASES

BOOLS = {"NoNewPrivileges", "PrivateTmp", "PrivateDevices", "ProtectKernelTunables",
         "ProtectKernelModules", "ProtectControlGroups", "RestrictSUIDSGID", "LockPersonality"}
REQUIRED = BOOLS | {"User", "Group", "ProtectSystem", "ProtectHome", "UMask",
                    "CapabilityBoundingSet", "AmbientCapabilities", "RestrictAddressFamilies",
                    "RestrictNamespaces", "ReadWritePaths"}


def valid_path(value):
    return (isinstance(value, str) and re.fullmatch(r"/[A-Za-z0-9_./-]+", value)
            and str(PurePosixPath(value)) == value and ".." not in PurePosixPath(value).parts
            and value not in {"/", "/etc", "/usr", "/var", "/home", "/root", "/run", "/tmp", "/opt", "/srv",
                              "/proc", "/sys", "/dev", "/var/lib", "/var/log", "/var/cache"})


def exception(value, now):
    if (not isinstance(value, dict) or set(value) != {"owner", "change_ref", "reason_ref", "review_until"}
            or not all(token(value[key]) for key in ("owner", "change_ref", "reason_ref"))
            or timestamp(value["review_until"]) <= now):
        raise ValueError("explicit unexpired owned exception required")


def compile_profile(profile, baseline, now):
    timestamp(now)
    if not isinstance(profile, dict) or not UNIT.fullmatch(profile.get("unit", "")):
        raise ValueError("exact service unit required")
    for key in ("owner", "approved_by", "change_ref", "inventory_ref"):
        if not token(profile.get(key)):
            raise ValueError("owned reviewed inventory and change reference required")
    if timestamp(profile.get("review_until")) <= now:
        raise ValueError("service profile review expired")
    properties = profile.get("properties")
    if not isinstance(properties, dict) or set(properties) != REQUIRED:
        raise ValueError("complete allowlisted confinement profile required")
    for key in BOOLS:
        if properties[key] not in {"yes", "no"}:
            raise ValueError("literal confinement switches required")
        if properties[key] != "yes":
            exception(profile.get("property_exceptions", {}).get(key), now)
    for key in ("User", "Group"):
        if not isinstance(properties[key], str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", properties[key]):
            raise ValueError("explicit Unix service identity required")
    if properties["User"] == "root" or properties["Group"] == "root":
        exception(profile.get("root_exception"), now)
    if properties["ProtectSystem"] != "strict" or properties["ProtectHome"] not in {"yes", "read-only", "tmpfs"}:
        raise ValueError("reviewed filesystem confinement required")
    if properties["UMask"] != "0077":
        raise ValueError("restrictive umask required")
    namespaces = properties["RestrictNamespaces"]
    if namespaces != "yes":
        if (not isinstance(namespaces, list) or not namespaces
                or any(v not in {"cgroup", "ipc", "net", "mnt", "pid", "user", "uts"} for v in namespaces)):
            raise ValueError("explicit namespace allowlist required")
        exception(profile.get("property_exceptions", {}).get("RestrictNamespaces"), now)
    for key in ("CapabilityBoundingSet", "AmbientCapabilities", "RestrictAddressFamilies", "ReadWritePaths"):
        values = properties[key]
        if not isinstance(values, list) or len(values) > 32 or any(not isinstance(v, str) for v in values) or len(set(values)) != len(values):
            raise ValueError("bounded distinct property list required")
    for key in ("CapabilityBoundingSet", "AmbientCapabilities"):
        if any(not re.fullmatch(r"CAP_[A-Z0-9_]+", value) for value in properties[key]):
            raise ValueError("invalid capability")
    if not set(properties["AmbientCapabilities"]) <= set(properties["CapabilityBoundingSet"]):
        raise ValueError("ambient capabilities exceed bounding set")
    capabilities = profile.get("capability_reasons", {})
    if set(capabilities) != set(properties["CapabilityBoundingSet"]) or not all(token(v) for v in capabilities.values()):
        raise ValueError("each capability requires an inventory reference")
    if (not properties["RestrictAddressFamilies"] or any(value not in {"AF_UNIX", "AF_INET", "AF_INET6", "AF_NETLINK"}
                                                       for value in properties["RestrictAddressFamilies"])):
        raise ValueError("reviewed address families required")
    if any(not valid_path(value) for value in properties["ReadWritePaths"]):
        raise ValueError("writable paths must be narrow literal absolute paths")
    persistence = profile.get("persistence_paths")
    if not isinstance(persistence, list) or not persistence or not all(valid_path(value) for value in persistence):
        raise ValueError("explicit persistence path inventory required")
    checks = profile.get("health_checks")
    if not isinstance(checks, list) or not checks or not all(token(check) for check in checks):
        raise ValueError("per-service health/routing/dependency checks required")
    budget = profile.get("task_budget")
    if (not isinstance(budget, dict) or type(budget.get("max")) is not int or budget["max"] < 1
            or type(budget.get("headroom_fraction")) not in (int, float)
            or not .25 <= budget["headroom_fraction"] <= 4 or not token(budget.get("basis_ref"))):
        raise ValueError("reviewed task limit, evidence and explicit headroom required")
    if (not isinstance(baseline, dict) or baseline.get("unit") != profile["unit"]
            or baseline.get("failed_count") != 0 or baseline.get("missing_phases") != []
            or type(baseline.get("span_seconds")) not in (int, float) or not math.isfinite(baseline["span_seconds"]) or baseline["span_seconds"] < 300
            or any(type(baseline.get("phase_counts", {}).get(phase)) is not int
                   or baseline["phase_counts"][phase] < 3 for phase in PHASES)
            or type(baseline.get("observed_peak")) is not int or baseline["observed_peak"] < 1):
        raise ValueError("representative reviewed startup/normal/peak/recovery baseline required")
    if budget["max"] < baseline["observed_peak"] * (1 + budget["headroom_fraction"]):
        raise ValueError("task limit lacks reviewed headroom above measured peak")
    restart = profile.get("restart")
    if (not isinstance(restart, dict) or set(restart) != {"delay_seconds", "interval_seconds", "burst"}
            or any(type(value) is not int for value in restart.values())
            or not 5 <= restart["delay_seconds"] <= 3600 or not 1 <= restart["burst"] <= 10
            or not restart["delay_seconds"] * restart["burst"] <= restart["interval_seconds"] <= 86400):
        raise ValueError("bounded restart delay and rate limit required")
    lines = ["# Reviewed candidate; install only in the approved per-service window.", "[Unit]",
             f"StartLimitIntervalSec={restart['interval_seconds']}", f"StartLimitBurst={restart['burst']}", "", "[Service]"]
    for key in sorted(properties):
        value = properties[key]
        if isinstance(value, list):
            # Reset inherited additive lists before setting exact reviewed sets.
            lines.append(key + "=")
            if value:
                lines.append(key + "=" + " ".join(value))
        else:
            lines.append(key + "=" + value)
    lines.extend([f"TasksMax={budget['max']}", f"RestartSec={restart['delay_seconds']}s", ""])
    content = "\n".join(lines)
    content_hash = hashlib.sha256(content.encode()).hexdigest()
    path = "/etc/systemd/system/" + profile["unit"] + ".d/90-orkestr-reviewed-hardening.conf"
    expiry = min([profile["review_until"], *[value["review_until"] for value in profile.get("property_exceptions", {}).values()],
                  *([profile["root_exception"]["review_until"]] if "root_exception" in profile else [])])
    posture = {"unit": profile["unit"], "reviewUntil": expiry, "properties": {**properties,
               "RestartUSec": restart["delay_seconds"], "StartLimitBurst": restart["burst"],
               "StartLimitIntervalUSec": restart["interval_seconds"]}, "paths": persistence,
               "taskBudget": {"max": budget["max"], "basis": budget["basis_ref"], "warningFraction": .8}}
    if "root_exception" in profile:
        posture["rootException"] = profile["root_exception"]
    return {"unit": profile["unit"], "profile_digest": digest(profile), "baseline_digest": digest(baseline),
            "candidate": {"path": path, "content": content, "sha256": content_hash, "install_requires_path_absent": True},
            "rollback": {"path": path, "only_remove_if_sha256": content_hash,
                         "preserve_other_dropins": True, "requires_approved_service_window": True},
            "health_checks": checks, "posture_profile": posture, "production_applied": False}


def verify_rollback(artifact, current_content):
    """Refuse rollback if any operator has changed the exact new drop-in."""
    expected_path = "/etc/systemd/system/" + artifact["unit"] + ".d/90-orkestr-reviewed-hardening.conf"
    return (artifact["candidate"]["path"] == expected_path == artifact["rollback"]["path"]
            and hashlib.sha256(current_content.encode()).hexdigest() == artifact["rollback"]["only_remove_if_sha256"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--baseline-report", required=True)
    args = parser.parse_args()
    profile, baseline = protected_json(args.profile), protected_json(args.baseline_report)
    matches = [row for row in baseline.get("services", []) if row.get("unit") == profile.get("unit")]
    if len(matches) != 1:
        raise ValueError("one matching unit baseline required")
    print(json.dumps(compile_profile(profile, matches[0], time.time()), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
