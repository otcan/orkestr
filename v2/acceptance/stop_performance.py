"""Ten-client local Stop probe; requires an exact exported ordinary fixture tree.

No providers/accounts. HTTP latency includes durable cancellation; physical
interrupt and terminal/reap assertions are separate from the latency metric.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import platform
import sqlite3
import subprocess
import sys
import threading
import time


def binary_identity(binary, expected_source):
    """Refuse unpinned/foreign binaries before creating fixture state."""
    if (len(expected_source) != 40
            or any(char not in "0123456789abcdef" for char in expected_source)):
        raise ValueError("expected source must be a full lowercase commit")
    result = subprocess.run([str(binary.resolve(strict=True)), "--version", "--json"],
                            check=True, capture_output=True, text=True, timeout=5)
    identity = json.loads(result.stdout)
    if (not isinstance(identity, dict)
            or identity.get("format") != "orkestr-v2-build-identity-v1"
            or identity.get("component") != "server"
            or identity.get("source_commit") != expected_source):
        raise ValueError("server embedded source identity mismatch")
    return identity


def measure(actions):
    barrier = threading.Barrier(len(actions))
    def run(item):
        index, action = item
        barrier.wait(timeout=10)
        start = time.perf_counter_ns()
        row = {"client": index, "started_ns": start, "ok": False}
        try:
            code, body, _ = action()
            row.update(status=code, receipt=body, ok=code == 200 and body.get("outcome") == "requested_unknown")
        except Exception as error:
            row["error"] = type(error).__name__
        row["duration_ns"] = time.perf_counter_ns() - start
        return row
    with ThreadPoolExecutor(max_workers=len(actions)) as pool:
        return list(pool.map(run, enumerate(actions)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("fixture_root", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--binary-sha256", required=True)
    parser.add_argument("--expected-source", required=True)
    args = parser.parse_args()
    assert hashlib.sha256(args.binary.read_bytes()).hexdigest() == args.binary_sha256
    identity = binary_identity(args.binary, args.expected_source)
    args.evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    sys.path.insert(0, str(args.fixture_root / "v2/tests"))
    sys.path.insert(0, str(args.fixture_root / "v2/acceptance"))
    # Ordinary fixture imports the executable from argv[1].
    sys.argv[1] = str(args.binary.resolve())
    from owned_execution_group import GroupCase, write_private, stop_request, broker
    from owned_native_probe import OwnedNativeProbe
    from owned_execution_http import Case, wait_for
    from intake_performance import summary

    class TenCase(GroupCase):
        def setup(self):
            Case.setup(self)
            self.conversations = [self.conversation]
            for index in range(1, 10):
                code, project, _ = self.request("/api/v2/projects", "POST", {
                    "client_request_id": f"perf-{index}", "name": f"Synthetic performance {index}"})
                assert code == 201
                self.conversations.append(project["conversation_id"])
            self.paths = [f"/api/v2/conversations/{item}" for item in self.conversations]

        def configure(self):
            Case.configure(self)
            first = json.loads((self.root / "execution.json").read_text())
            configs = [str(self.root / "execution.json")]
            for index in range(1, 10):
                workspace = self.root / f"workspace-{index}"
                workspace.mkdir(mode=0o700)
                self.workspaces.append(workspace)
                self.probes.append(OwnedNativeProbe(self.root / "synthetic-provider"))
                home, temporary = self.root / f"provider-{index}", self.root / f"tmp-{index}"
                home.mkdir(mode=0o700)
                temporary.mkdir(mode=0o700)
                private = self.root / f"broker-{index}.json"
                write_private(private, {"codex_executable": str(self.root / "synthetic-provider"),
                    "codex_home": str(home), "home": str(home), "temporary": str(temporary),
                    "workspace": str(workspace)})
                launcher = self.root / f"launcher-{index}"
                launcher.write_text("#!/usr/bin/python3\nimport sys\n" +
                    f"sys.path.insert(0, {str(broker)!r})\nfrom server import main\n" +
                    f"raise SystemExit(main({str(private)!r}))\n")
                launcher.chmod(0o700)
                config = self.root / f"execution-{index}.json"
                write_private(config, {**first, "conversation_id": self.conversations[index],
                    "workspace": str(workspace), "launcher": str(launcher),
                    "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest(),
                    "namespace": f"synthetic:perf-{index}", "supervisor_key": f"perf-{index}"})
                configs.append(str(config))
            write_private(self.root / "execution-set.json", {"schema_version": 1,
                "mode": "isolated-acceptance-set-v1", "configurations": configs})

    case, samples = TenCase(), []
    report = {"binary_sha256": args.binary_sha256, "source": identity["source_commit"], "embedded_identity": identity,
              "platform": platform.platform(), "debug_candidate": True, "full_release_qualified": False}
    try:
        case.setup()
        case.stop()
        case.configure()
        for workspace in case.workspaces:
            (workspace / "stop-mode").write_text("terminal")
        case.start(configured=True)
        for path in case.paths:
            assert case.request(path + "/messages", "POST", {
                "client_message_id": "synthetic:1", "text": "synthetic ordinary HTTP input"})[0] == 202
        statuses = []
        for index in range(10):
            def ready(index=index):
                value = case.status(index, "running")
                return value if value and value["progress"] and value["capabilities"]["stop"] else None
            statuses.append(wait_for(ready, "ten native turns ready", seconds=20))
        assert len({value["run_id"] for value in statuses}) == 10
        bodies = [stop_request(value, f"performance-stop-{index}") for index, value in enumerate(statuses)]
        samples = measure([lambda index=index: case.request(case.paths[index] + "/stop", "POST", bodies[index])
                           for index in range(10)])
        assert all(row["ok"] for row in samples), samples
        # Every successful request must already have installed the durable fence.
        with sqlite3.connect(f"file:{case.home / 'core.sqlite3'}?mode=ro", uri=True) as db:
            assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 10
            assert db.execute("SELECT count(*) FROM production_runs WHERE state='cancel_requested'").fetchone()[0] == 10
        for index in range(10):
            wait_for(lambda index=index: any(row["kind"] == "interrupt-ack" for row in case.trace_for(index)),
                     "actual local interrupt")
            assert sum(row["kind"] == "interrupt" for row in case.trace_for(index)) == 1
            (case.workspaces[index] / "release-stop").touch()
        for index in range(10):
            wait_for(lambda index=index: case.status(index, "cancelled"), "correlated terminal")
        wait_for(case.peer_gone, "all native identities reaped")
        report["physical_stop_verified"] = True
    except Exception as error:
        report["failure"] = repr(error)
    finally:
        (args.evidence / "samples.json").write_text(json.dumps(samples, indent=2))
        (args.evidence / "trace.json").write_text(json.dumps(case.trace(), indent=2))
        case.cleanup()
        report.update(metric=summary(samples, 10, 250), native_cleanup=case.peer_gone(),
                      state_removed=not case.root.exists())
        (args.evidence / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return 0 if report.get("physical_stop_verified") and report["metric"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
