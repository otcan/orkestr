#!/usr/bin/env python3
"""Read-only, allowlisted systemd drift and per-service task-budget checker."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess


PROPERTIES = (
    "Id", "LoadState", "ActiveState", "User", "TasksCurrent", "TasksMax",
    "MemoryCurrent", "NoNewPrivileges", "PrivateTmp", "PrivateDevices",
    "ProtectSystem", "ProtectHome", "ProtectKernelTunables", "ProtectKernelModules",
    "ProtectControlGroups", "RestrictSUIDSGID", "LockPersonality", "UMask",
    "CapabilityBoundingSet", "AmbientCapabilities", "RestartUSec",
    "StartLimitBurst", "StartLimitIntervalUSec",
)
UNIT = re.compile(r"[A-Za-z0-9_.@:-]+\.service\Z")


def parse_properties(text):
    result = {}
    for line in text.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in PROPERTIES:
            result[key] = value
    return result


def inspect_paths(paths):
    """Check reviewed executable/unit paths and both symlink and target parents.

    Only ownership/mode is inspected; no file contents or command arguments.
    This Unix-mode check does not claim ACL, mount or root-compromise coverage.
    """
    issues = []
    for value in paths:
        candidate = Path(value)
        if not candidate.is_absolute():
            raise ValueError("reviewed paths must be absolute")
        chain = {candidate, *candidate.parents}
        try:
            resolved = candidate.resolve(strict=True)
            chain |= {resolved, *resolved.parents}
        except (OSError, RuntimeError):
            issues.append({"path": value, "reason": "missing_or_unresolvable"})
            continue
        for component in sorted(chain, key=str):
            try:
                metadata = component.lstat()
            except OSError:
                issues.append({"path": str(component), "reason": "unreadable"})
                continue
            if metadata.st_uid != 0:
                issues.append({"path": str(component), "reason": "not_root_owned"})
            if not stat.S_ISLNK(metadata.st_mode) and metadata.st_mode & 0o022:
                issues.append({"path": str(component), "reason": "group_or_other_writable"})
    return issues


def evaluate(actual, profile):
    findings = []
    if actual.get("LoadState") != "loaded":
        findings.append("unit_not_loaded")
    if actual.get("ActiveState") != "active":
        findings.append("unit_not_active")
    required = profile.get("properties", {})
    if not isinstance(required, dict) or any(key not in PROPERTIES for key in required):
        raise ValueError("only allowlisted properties may be inspected")
    for key, expected in required.items():
        if str(actual.get(key, "")) != str(expected):
            findings.append("property_drift:" + key)
    if actual.get("User") in (None, "", "0", "root") and not profile.get("rootException"):
        findings.append("undocumented_root_identity")
    budget = profile.get("taskBudget")
    if not budget:
        findings.append("task_budget_unreviewed")
    else:
        maximum = budget.get("max")
        if (not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1
                or not budget.get("basis") or not isinstance(budget.get("warningFraction", 0.8), (float, int))
                or not 0 < budget.get("warningFraction", 0.8) < 1):
            raise ValueError("task budget needs a positive bound, evidence basis and warning fraction")
        try:
            current, configured = int(actual["TasksCurrent"]), int(actual["TasksMax"])
            if current < 0 or configured < 1:
                raise ValueError()
        except (KeyError, ValueError):
            findings.append("task_counts_unavailable_or_unbounded")
        else:
            if configured != maximum:
                findings.append("task_limit_drift")
            if current >= maximum * budget.get("warningFraction", 0.8):
                findings.append("task_pressure")
    return findings


def collect(profile, runner=subprocess.run):
    unit = profile.get("unit", "")
    if not isinstance(unit, str) or not UNIT.fullmatch(unit):
        raise ValueError("invalid service unit")
    response = runner(["systemctl", "show", unit, "--no-pager", "--property=" + ",".join(PROPERTIES)],
                      capture_output=True, text=True, timeout=10, check=False,
                      env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    if response.returncode:
        return {"unit": unit, "ok": False, "findings": ["property_read_failed"]}
    actual = parse_properties(response.stdout)
    findings = evaluate(actual, profile)
    paths = inspect_paths(profile.get("paths", []))
    if not profile.get("paths"):
        findings.append("persistence_paths_unreviewed")
    return {"unit": unit, "ok": not findings and not paths, "properties": actual,
            "findings": findings, "path_findings": paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profiles", required=True, help="private reviewed unit profiles JSON")
    args = parser.parse_args()
    with open(args.profiles, encoding="utf-8") as handle:
        profiles = json.load(handle)
    if not isinstance(profiles, list) or not 1 <= len(profiles) <= 32:
        raise ValueError("one to 32 explicitly scoped service profiles required")
    results = [collect(profile) for profile in profiles]
    print(json.dumps({"ok": all(row["ok"] for row in results), "services": results}, sort_keys=True))
    return 0 if all(row["ok"] for row in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())
