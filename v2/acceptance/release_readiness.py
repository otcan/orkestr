#!/usr/bin/env python3
"""Validate a private, versioned release evidence packet without running effects."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys

from release_evidence_policy import (
    GATES, MAX_FRESHNESS_SECONDS, MAX_SOAK_SEGMENT_SECONDS, PERFORMANCE,
    SCHEMA_VERSION, SHORT_FRESHNESS_SECONDS, SOAK_SECONDS, STAGES,
)


class EvidenceError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise EvidenceError(reason)


def mapping(value):
    require(isinstance(value, dict), "expected an object")
    return value


def string(value):
    require(isinstance(value, str) and bool(value.strip()), "expected nonempty text")
    return value


def strings(value, allow_empty=False):
    require(isinstance(value, list), "expected a list")
    require(allow_empty or bool(value), "list cannot be empty")
    for entry in value:
        string(entry)
    require(len(set(value)) == len(value), "duplicate list entries")
    return set(value)


def integer(value, minimum=0):
    require(type(value) is int and value >= minimum, f"expected integer >= {minimum}")
    return value


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value),
        "expected UTC timestamp ending in Z")
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise EvidenceError("invalid timestamp") from error


def digest(value, length=64):
    require(isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{length}}}", value),
            f"expected full lowercase {length}-character digest")
    return value


def semantic_version(value):
    match = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
                         r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
                         r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", string(value))
    require(match is not None, "artifact version must be SemVer")
    if match.group(4):
        require(all(not part.isdigit() or len(part) == 1 or not part.startswith("0")
                    for part in match.group(4).split(".")), "invalid numeric prerelease version")


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise EvidenceError("non-finite JSON number")

    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid_constant)


class Validator:
    def __init__(self, packet, scope, scope_bytes, artifact_root, revision, now):
        self.packet = mapping(packet)
        self.scope = mapping(scope)
        self.scope_bytes = scope_bytes
        self.root = Path(artifact_root).resolve(strict=True)
        self.revision = digest(revision, 40)
        self.now = now
        self.checked_artifacts = set()
        self.used_workflows = set()
        self.ci_statuses = {}

    def artifact(self, reference):
        item = mapping(reference)
        expected = digest(item.get("sha256"))
        relative = Path(string(item.get("path")))
        require(not relative.is_absolute() and ".." not in relative.parts,
                "artifact path must remain inside the artifact root")
        try:
            path = (self.root / relative).resolve(strict=True)
            require(path.is_relative_to(self.root) and path.is_file(),
                    "artifact must be a file inside the artifact root")
            if (path, expected) not in self.checked_artifacts:
                with path.open("rb") as handle:
                    actual = hashlib.file_digest(handle, "sha256").hexdigest()
                require(actual == expected, "artifact SHA-256 mismatch")
                self.checked_artifacts.add((path, expected))
            return path
        except OSError as error:
            raise EvidenceError("artifact is missing or unreadable") from error

    def header(self):
        require(self.packet.get("schema_version") == SCHEMA_VERSION
                and type(self.packet.get("schema_version")) is int,
                "unsupported evidence schema version")
        require(self.scope.get("schema_version") == SCHEMA_VERSION
                and type(self.scope.get("schema_version")) is int,
                "unsupported scope schema version")
        require(self.packet.get("scope_sha256") == hashlib.sha256(self.scope_bytes).hexdigest(),
                "reviewed scope digest mismatch")
        require(strict_json(self.scope_bytes) == self.scope, "scope object differs from reviewed bytes")
        digest(self.scope.get("baseline_revision"), 40)
        string(self.scope.get("reviewed_by"))
        require(timestamp(self.scope.get("reviewed_at")) <= self.now, "scope review is in the future")
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
                             string(self.scope.get("repository"))), "invalid repository")
        strings(self.scope.get("required_ci"))
        strings(self.scope.get("release_ci"))
        conditional = mapping(self.scope.get("conditional_ci_skips", {}))
        require(not set(conditional).intersection(self.scope["required_ci"]),
                "required CI cannot have a conditional skip")
        for name, condition in conditional.items():
            string(name)
            mapping(condition)
            string(condition.get("reason"))
            require(strings(condition.get("stages")).issubset(STAGES), "invalid conditional CI stage")
        strings(self.scope.get("install_targets"))
        workflows = mapping(self.scope.get("workflows"))
        require(bool(workflows), "workflow inventory is empty")
        for name, used in workflows.items():
            string(name)
            require(type(used) is bool, "workflow usage must be boolean")
            if used:
                self.used_workflows.add(name)
        require(bool(self.used_workflows), "no used workflows inventoried")
        self.artifact(self.scope.get("inventory_artifact"))
        require(timestamp(self.packet.get("generated_at")) <= self.now,
                "packet generation is in the future")
        candidate = mapping(self.packet.get("candidate"))
        require(candidate.get("revision") == self.revision, "candidate revision mismatch")
        semantic_version(candidate.get("version"))
        require(timestamp(candidate.get("built_at")) <= self.now, "candidate build is in the future")
        require(timestamp(candidate["built_at"]) <= timestamp(self.packet["generated_at"]),
                "packet predates candidate build")
        self.artifact(candidate.get("artifact"))
        self.artifact(candidate.get("configuration"))
        gates = mapping(self.packet.get("gates"))
        require(set(gates).issubset(GATES), "unknown gate in evidence packet")

    def common(self, name, gate):
        mapping(gate)
        require(gate.get("status") == "passed", "status is not passed")
        require(gate.get("revision") == self.revision, "evidence is for a different revision")
        require(gate.get("execution") == GATES[name][1], "wrong execution mode; fixture is not live evidence")
        if name == "release_artifacts":
            require(gate.get("candidate_artifact_sha256") == self.packet["candidate"]["artifact"]["sha256"],
                    "release artifact mismatch")
        if GATES[name][1] in {"production", "real_provider"}:
            candidate = self.packet["candidate"]
            require(gate.get("candidate_artifact_sha256") == candidate["artifact"]["sha256"],
                    "candidate artifact mismatch")
            require(gate.get("configuration_sha256") == candidate["configuration"]["sha256"],
                    "candidate configuration mismatch")
        start = timestamp(gate.get("started_at"))
        end = timestamp(gate.get("completed_at"))
        if GATES[name][1] in {"production", "real_provider"}:
            require(start >= timestamp(self.packet["candidate"]["built_at"]), "live evidence predates candidate build")
        expires = timestamp(gate.get("expires_at"))
        require(start <= end <= self.now, "invalid or unfinished evidence interval")
        require(end <= timestamp(self.packet.get("generated_at")), "packet predates evidence completion")
        freshness = SHORT_FRESHNESS_SECONDS if name == "soak" else MAX_FRESHNESS_SECONDS
        require(end < expires and (expires - end).total_seconds() <= freshness,
                "evidence expiry exceeds freshness policy")
        require(self.now <= expires, "evidence expired")
        artifacts = gate.get("artifacts")
        require(isinstance(artifacts, list) and bool(artifacts), "gate needs artifacts")
        for reference in artifacts:
            self.artifact(reference)
        cases = mapping(gate.get("cases"))
        required = set(GATES[name][2])
        if name == "workflow_parity":
            required |= self.used_workflows
        if name == "installation":
            required |= {f"{action}/{target}" for target in self.scope["install_targets"]
                         for action in ("clean_install", "upgrade", "backup_restore")}
        require(required.issubset(cases), "missing required cases: " + ", ".join(sorted(required - cases.keys())))
        require(all(status == "passed" for status in cases.values()), "a case is not passed")

    def ci(self, gate):
        require(gate.get("snapshot_filter") == "latest", "CI snapshot must use the latest filter")
        path = self.artifact(gate.get("snapshot"))
        try:
            snapshot = mapping(strict_json(path.read_bytes()))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise EvidenceError("invalid CI snapshot JSON") from error
        checks = snapshot.get("check_runs")
        require(isinstance(checks, list) and bool(checks), "CI check runs are missing")
        require(integer(snapshot.get("total_count"), 1) == len(checks), "incomplete CI snapshot pagination")
        names = set()
        check_ids = set()
        for check in checks:
            mapping(check)
            name = string(check.get("name"))
            require(name not in names, "duplicate CI check name")
            names.add(name)
            check_id = integer(check.get("id"), 1)
            require(check_id not in check_ids, "duplicate CI check run ID")
            check_ids.add(check_id)
            require(check.get("head_sha") == self.revision, "CI revision mismatch")
            require(check.get("status") == "completed", "CI is pending")
            conclusion = check.get("conclusion")
            conditional = self.scope.get("conditional_ci_skips", {})
            require(conclusion == "success" or (conclusion == "skipped" and name in conditional),
                    "CI failed, skipped without review, or did not succeed")
            completed = timestamp(check.get("completed_at"))
            require(completed <= timestamp(gate["completed_at"]),
                    "CI snapshot predates check completion")
            require((self.now - completed).total_seconds() <= MAX_FRESHNESS_SECONDS,
                    "CI check execution expired")
            self.ci_statuses[name] = conclusion
            prefix = "https://github.com/" + self.scope["repository"] + "/actions/runs/"
            require(re.fullmatch(re.escape(prefix) + r"[1-9][0-9]*(?:/job/[0-9]+)?",
                                 string(check.get("details_url"))), "CI run URL mismatch")
        required = set(self.scope["required_ci"])
        require(required.issubset(names), "missing required CI: " + ", ".join(sorted(required - names)))

    def ci_stage_blockers(self, stage):
        reasons = []
        for name, conclusion in self.ci_statuses.items():
            if conclusion == "skipped" and stage not in self.scope["conditional_ci_skips"][name]["stages"]:
                reasons.append("conditional CI skip not allowed at this stage: " + name)
        if stage == "full_release":
            for name in self.scope["release_ci"]:
                if self.ci_statuses.get(name) != "success":
                    reasons.append("successful release CI required: " + name)
        return [{"gate": "ci", "reason": reason} for reason in reasons]

    def provider(self, name, gate):
        provider = name.removeprefix("provider_")
        require(gate.get("provider") == provider, "wrong provider")
        require(gate.get("isolated_profile") is True, "isolated provider profile not verified")
        sessions = mapping(gate.get("native_sessions"))
        require(set(sessions) == {"fast", "deep", "worker"}, "missing native role identities")
        identities = [string(value) for value in sessions.values()]
        require(len(set(identities)) == 3, "provider roles reuse a native session")

    def performance(self, gate):
        string(gate.get("environment"))
        measures = mapping(gate.get("measurements"))
        for name, (threshold, clients) in PERFORMANCE.items():
            measure = mapping(measures.get(name))
            require(integer(measure.get("concurrent_clients"), 1) == clients,
                    f"{name}: wrong concurrent client count")
            require(measure.get("unit") == "ms", f"{name}: measurements must be milliseconds")
            samples = measure.get("samples")
            require(isinstance(samples, list) and len(samples) >= 100,
                    f"{name}: at least 100 samples required")
            require(all(type(sample) in (int, float) and 0 <= sample <= 1e12 and math.isfinite(sample)
                        for sample in samples), f"{name}: invalid sample")
            percentile = sorted(samples)[math.ceil(0.95 * len(samples)) - 1]
            require(percentile < threshold, f"{name}: p95 must be below {threshold} ms")
            if name == "thread_load":
                require(measure.get("access_path") == "normal_user_path",
                        "thread_load: must measure normal user access path")

    def soak(self, gate):
        require(gate.get("environment") == "daily_use_production", "soak must cover actual daily-use production")
        start = timestamp(gate["started_at"])
        end = timestamp(gate["completed_at"])
        require(start >= timestamp(self.packet["candidate"]["built_at"]), "soak predates candidate build")
        require((end - start).total_seconds() >= SOAK_SECONDS, "soak is shorter than 72 hours")
        require(integer(gate.get("material_fixes")) == 0, "material fixes require a new soak")
        require(integer(gate.get("incidents")) == 0, "incidents interrupt the soak")
        segments = gate.get("segments")
        require(isinstance(segments, list) and bool(segments), "soak continuity segments missing")
        cursor = start
        for segment in segments:
            mapping(segment)
            require(segment.get("revision") == self.revision, "soak changed candidate revision")
            require(segment.get("candidate_artifact_sha256") == gate["candidate_artifact_sha256"]
                    and segment.get("configuration_sha256") == gate["configuration_sha256"],
                    "soak changed candidate artifact or configuration")
            require(segment.get("status") == "passed", "soak segment did not pass")
            segment_start = timestamp(segment.get("started_at"))
            segment_end = timestamp(segment.get("completed_at"))
            require(segment_start == cursor, "soak contains an overlap or observation gap")
            require(0 < (segment_end - segment_start).total_seconds() <= MAX_SOAK_SEGMENT_SECONDS,
                    "soak observations must be no more than one hour apart")
            require(segment_end <= end, "soak segment exceeds reported completion")
            cursor = segment_end
        require(cursor == end, "soak observations do not cover the complete interval")

    def gate(self, name):
        gate = self.packet["gates"].get(name)
        require(gate is not None, "missing gate")
        self.common(name, gate)
        if name == "ci":
            self.ci(gate)
        elif name.startswith("provider_"):
            self.provider(name, gate)
        elif name == "performance":
            self.performance(gate)
        elif name == "web":
            integer(gate.get("history_messages"), 10000)
            integer(gate.get("busy_turn_seconds"), 30)
            require(gate.get("composer_editable") is True, "busy composer was not editable")
        elif name == "soak":
            self.soak(gate)
        elif name == "cutover":
            require(gate.get("environment") == "daily_use_production", "cutover must be actual production")
            backup = timestamp(gate.get("backup_completed_at"))
            start = timestamp(gate["started_at"])
            require(0 <= (start - backup).total_seconds() <= SHORT_FRESHNESS_SECONDS,
                    "cutover needs a backup completed within the preceding 24 hours")


def evaluate(packet, scope, scope_bytes, artifact_root, revision, *, now=None, requested="full_release"):
    """Return all staged blockers. `now` is injectable for deterministic unit tests."""
    now = now or datetime.now(timezone.utc)
    require(requested in STAGES, "unknown requested readiness stage")
    failures = {}
    try:
        validator = Validator(packet, scope, scope_bytes, artifact_root, revision, now)
        validator.header()
    except (ValueError, OSError) as error:
        failures["packet"] = str(error)
    else:
        if not re.fullmatch(r"2\.0\.0(?:-rc\.[1-9][0-9]*)?", packet["candidate"]["version"]):
            failures["candidate_version"] = "candidate requires artifact version 2.0.0-rc.N or 2.0.0"
        for name in GATES:
            try:
                validator.gate(name)
            except (ValueError, OSError) as error:
                failures[name] = str(error)
    stages = {}
    highest = "unqualified"
    for index, stage in enumerate(STAGES):
        required = {name for name, (minimum, _, _) in GATES.items() if STAGES.index(minimum) <= index}
        if index > 0:
            required.add("candidate_version")
        blockers = [{"gate": name, "reason": reason} for name, reason in failures.items()
                    if name == "packet" or name in required]
        if "packet" not in failures and "ci" not in failures:
            blockers += validator.ci_stage_blockers(stage)
        stages[stage] = {"ready": not blockers, "blockers": blockers}
        if not blockers:
            highest = stage
    return {
        "schema_version": SCHEMA_VERSION,
        "candidate_revision": revision,
        "evaluated_at": now.isoformat().replace("+00:00", "Z"),
        "highest_ready_stage": highest,
        "requested_stage": requested,
        "ready": stages[requested]["ready"],
        "stages": stages,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--scope", required=True, type=Path)
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--revision", required=True, help="exact candidate commit, independently resolved")
    parser.add_argument("--require", choices=STAGES, default="full_release", dest="requested")
    args = parser.parse_args(argv)
    try:
        scope_bytes = args.scope.read_bytes()
        result = evaluate(strict_json(args.evidence.read_bytes()), strict_json(scope_bytes),
                          scope_bytes, args.artifact_root, args.revision, requested=args.requested)
    except (ValueError, OSError) as error:
        print(json.dumps({"ready": False, "error": "invalid evidence input", "detail": str(error)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
