#!/usr/bin/env python3
"""Read-only route and resource telemetry; protected-file monitor ingestion.

Ship stdout through an approved authenticated path to a protected collector
file. This tool never changes routes, VPN state, services or firewall policy.
"""
import argparse
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time

from audit_paths import check_directory_chain
from evidence_archive import digest, timestamp
from service_audit import token
from task_baseline import read_sample
from systemd_posture import UNIT


MISSING_TABLE = object()


def table_id(value=MISSING_TABLE, *, route_get=False):
    """Normalize only iproute2's built-ins and explicit numeric table IDs.

    print_route omits RT_TABLE_MAIN for an unfiltered route-get result. Rule
    records have no such default. Unknown administrator aliases are not guessed.
    """
    if value is MISSING_TABLE:
        return 254 if route_get else None
    if isinstance(value, str):
        if value in {"local", "main", "default"}:
            return {"local": 255, "main": 254, "default": 253}[value]
        if not re.fullmatch(r"[1-9][0-9]{0,9}", value):
            return None
        value = int(value)
    return value if type(value) is int and 1 <= value <= 4294967295 else None


def protected_json(path):
    path = Path(os.path.abspath(path))
    check_directory_chain(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in {0, os.geteuid()}
                or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 65536):
            raise ValueError("unsafe telemetry file")
        with os.fdopen(fd, encoding="utf-8") as handle:
            fd = None
            raw = handle.read(65537)
        if len(raw) > 65536:
            raise ValueError("telemetry exceeds bound")
        return json.loads(raw)
    finally:
        if fd is not None:
            os.close(fd)


def validate_policy(policy):
    if not isinstance(policy, dict) or not token(policy.get("source_id")):
        raise ValueError("explicit internal source identity required")
    routes = policy.get("routes")
    if not isinstance(routes, list) or not 1 <= len(routes) <= 8:
        raise ValueError("one to eight exact source routes required")
    for route in routes:
        if not isinstance(route, dict) or set(route) != {"source", "destination", "gateway", "device", "table", "priority"}:
            raise ValueError("complete route expectation required")
        addresses = [ipaddress.ip_address(route[key]) for key in ("source", "destination", "gateway")]
        if len({address.version for address in addresses}) != 1:
            raise ValueError("route address families must match")
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,32}", route["device"]):
            raise ValueError("invalid physical interface")
        if any(type(route[key]) is not int or not 1 <= route[key] <= 2147483647 for key in ("table", "priority")):
            raise ValueError("explicit route table/priority required")
    units = policy.get("task_budgets")
    if (not isinstance(units, dict) or not 1 <= len(units) <= 32
            or any(not UNIT.fullmatch(unit) or type(bound) is not int or bound < 1 for unit, bound in units.items())):
        raise ValueError("explicit task warning bounds required")
    thresholds = policy.get("thresholds")
    keys = {"memory_available_fraction", "swap_used_fraction", "memory_psi_avg10", "file_used_fraction", "host_tasks"}
    if not isinstance(thresholds, dict) or set(thresholds) != keys:
        raise ValueError("complete resource warning policy required")
    for key, value in thresholds.items():
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError("invalid resource threshold")
        if "fraction" in key and value >= 1 or key == "memory_psi_avg10" and value > 100:
            raise ValueError("resource threshold out of range")
    return policy


def command_json(arguments, runner):
    result = runner(arguments, capture_output=True, text=True, timeout=5, check=False,
                    env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    if result.returncode or len(result.stdout) > 65536:
        raise ValueError("metadata read failed")
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("metadata record list required")
    return rows


def collect(policy, now=None, runner=subprocess.run, read_text=None):
    validate_policy(policy)
    now = timestamp(time.time() if now is None else now)
    read_text = read_text or (lambda path: Path(path).read_text(encoding="ascii"))
    errors, metrics, route_results = [], {}, []
    for expectation in policy["routes"]:
        family = "-4" if ipaddress.ip_address(expectation["source"]).version == 4 else "-6"
        try:
            routes = command_json(["ip", family, "-j", "route", "get", expectation["destination"], "from", expectation["source"]], runner)
            rules = command_json(["ip", family, "-j", "rule", "show"], runner)
            route = routes[0] if len(routes) == 1 else {}
            source = ipaddress.ip_address(expectation["source"])
            matching_rule = any(rule.get("priority") == expectation["priority"]
                                and table_id(rule.get("table", MISSING_TABLE)) == expectation["table"]
                                and ipaddress.ip_network(rule.get("src", "all"), strict=False)
                                == ipaddress.ip_network(str(source) + "/" + str(source.max_prefixlen)) for rule in rules
                                if rule.get("src") not in (None, "all"))
            route_results.append(route.get("dev") == expectation["device"]
                                 and route.get("gateway") == expectation["gateway"]
                                 and route.get("type", "unicast") == "unicast"
                                 and table_id(route.get("table", MISSING_TABLE), route_get=True) == expectation["table"]
                                 and matching_rule)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            errors.append("route_read_failed")
    try:
        links = command_json(["ip", "-j", "link", "show"], runner)
        # Even an isolated network namespace has a loopback link. Missing names
        # or an empty inventory cannot establish absence of a prohibited link.
        if not links or any(not isinstance(link.get("ifname"), str) or not link["ifname"] for link in links):
            raise ValueError("complete link metadata required")
        vpn_absent = all(link.get("ifname") != "nordlynx" for link in links)
        for unit in ("nordvpn.service", "nordvpnd.service", "nordvpnd.socket"):
            result = runner(["systemctl", "show", unit, "--no-pager", "--property=Id,ActiveState,UnitFileState"],
                            capture_output=True, text=True, timeout=5, check=False,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
            if result.returncode or len(result.stdout) > 8192:
                raise ValueError("VPN unit metadata unavailable")
            props = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
            vpn_absent = vpn_absent and props.get("Id") == unit and props.get("ActiveState") == "inactive" and props.get("UnitFileState") == "masked"
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        vpn_absent = None
        errors.append("vpn_read_failed")
    try:
        memory = {}
        for line in read_text("/proc/meminfo").splitlines():
            key, _, value = line.partition(":")
            if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
                memory[key] = int(value.split()[0])
        total, available, swap, free_swap = (memory[k] for k in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"))
        if not 0 <= available <= total or total == 0 or not 0 <= free_swap <= swap:
            raise ValueError()
        psi = next(line for line in read_text("/proc/pressure/memory").splitlines() if line.startswith("some "))
        avg10 = float(dict(field.split("=", 1) for field in psi.split()[1:])["avg10"])
        allocated, unused, maximum = map(int, read_text("/proc/sys/fs/file-nr").split())
        host_tasks = int(read_text("/proc/loadavg").split()[3].split("/")[1])
        if not math.isfinite(avg10) or not 0 <= avg10 <= 100 or not 0 <= unused <= allocated <= maximum or maximum <= 0 or host_tasks < 1:
            raise ValueError()
        metrics = {"memory_available_fraction": available / total, "swap_used_fraction": (swap-free_swap)/swap if swap else 0,
                   "memory_psi_avg10": avg10, "file_used_fraction": (allocated-unused)/maximum, "host_tasks": host_tasks}
    except (OSError, ValueError, KeyError, IndexError, StopIteration):
        errors.append("resource_read_failed")
    tasks = [read_sample(unit, runner) for unit in sorted(policy["task_budgets"])]
    if any("error" in row for row in tasks):
        errors.append("task_read_failed")
    pressure = None
    if metrics and not any("error" in row for row in tasks):
        limits = policy["thresholds"]
        pressure = (metrics["memory_available_fraction"] <= limits["memory_available_fraction"]
                    or any(metrics[k] >= limits[k] for k in limits if k != "memory_available_fraction")
                    or any(row["tasks"] >= policy["task_budgets"][row["unit"]] for row in tasks))
    route_ok = all(route_results) and vpn_absent if len(route_results) == len(policy["routes"]) else None
    return {"version": 1, "source_id": policy["source_id"], "policy_digest": digest(policy), "observed_at": now,
            "route_ok": route_ok, "resource_pressure": pressure, "vpn_absent": vpn_absent,
            "metrics": metrics, "tasks": tasks, "errors": sorted(set(errors))}


def load_signal(path, source_id, policy_digest, now, stale_seconds=120):
    signal = protected_json(path)
    if (not isinstance(signal, dict) or type(signal.get("version")) is not int or signal["version"] != 1 or signal.get("source_id") != source_id
            or signal.get("policy_digest") != policy_digest):
        raise ValueError("internal telemetry source/policy mismatch")
    observed = timestamp(signal.get("observed_at"))
    if not 0 <= now - observed <= stale_seconds:
        raise ValueError("internal telemetry stale or from future")
    if signal.get("errors") != []:
        raise ValueError("internal telemetry collection incomplete")
    for key in ("route_ok", "resource_pressure", "vpn_absent"):
        if type(signal.get(key)) is not bool:
            raise ValueError("invalid internal telemetry boolean")
    if signal["route_ok"] and not signal["vpn_absent"]:
        raise ValueError("inconsistent internal route telemetry")
    # No caller extras, file paths or arbitrary text enter the incident record.
    return {key: signal.get(key) for key in ("observed_at", "route_ok", "resource_pressure")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True)
    args = parser.parse_args()
    result = collect(protected_json(args.policy))
    print(json.dumps(result, sort_keys=True))
    return 2 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
