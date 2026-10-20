"""Two ordinary conversations, independent native trees and exact HTTP controls.

Every account, workspace, token and peer is disposable synthetic fixture state.
The unchanged host-identity oracle observes real descendants before any Stop.
"""
import hashlib
import json
import sqlite3
import uuid
from owned_execution_http import Case, broker, wait_for
from owned_native_probe import OwnedNativeProbe


def write_private(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


class GroupCase(Case):
    def __init__(self):
        super().__init__()
        self.workspaces = [self.workspace]
        self.probes = [self.native_probe]

    def start(self, configured=False, refused=False):
        return super().start(configured, refused, config_set=configured)

    def setup(self):
        super().setup()
        code, project, _ = self.request("/api/v2/projects", "POST", {
            "client_request_id": "second-conversation", "name": "Synthetic second project"})
        assert code == 201
        self.conversations = [self.conversation, project["conversation_id"]]
        self.paths = [f"/api/v2/conversations/{item}" for item in self.conversations]

    def configure(self):
        super().configure()
        workspace = self.root / "second-workspace"
        workspace.mkdir(mode=0o700)
        self.workspaces.append(workspace)
        self.probes.append(OwnedNativeProbe(self.root / "synthetic-provider"))
        provider_home, provider_tmp = self.root / "second-provider-home", self.root / "second-provider-tmp"
        provider_home.mkdir(mode=0o700)
        provider_tmp.mkdir(mode=0o700)
        private = self.root / "second-broker-private.json"
        write_private(private, {"codex_executable": str(self.root / "synthetic-provider"),
            "codex_home": str(provider_home), "home": str(provider_home),
            "temporary": str(provider_tmp), "workspace": str(workspace)})
        launcher = self.root / "second-launcher"
        launcher.write_text("#!/usr/bin/python3\nimport sys\n"
                           f"sys.path.insert(0, {str(broker)!r})\nfrom server import main\n"
                           f"raise SystemExit(main({str(private)!r}))\n")
        launcher.chmod(0o700)
        first = json.loads((self.root / "execution.json").read_text())
        second = {**first, "conversation_id": self.conversations[1], "workspace": str(workspace),
                  "launcher": str(launcher), "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest(),
                  "namespace": "synthetic:second", "supervisor_key": "synthetic-second"}
        write_private(self.root / "second-execution.json", second)
        self.manifest = {"schema_version": 1, "mode": "isolated-acceptance-set-v1",
                         "configurations": [str(self.root / "execution.json"),
                                            str(self.root / "second-execution.json")]}
        write_private(self.root / "execution-set.json", self.manifest)

    def trace_for(self, index):
        path = self.workspaces[index] / "synthetic-peer.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return self.probes[index].observe(self.process.pid if self.process else None, rows)

    def trace(self):
        return [row for index in range(len(self.workspaces)) for row in self.trace_for(index)]

    def peer_gone(self):
        self.trace()
        return all(probe.gone() for probe in self.probes)

    def status(self, index, phase):
        code, body, _ = self.request(self.paths[index] + "/execution")
        self.trace()
        return body if code == 200 and body["phase"] == phase else None

    def both_running(self):
        self.stop()
        self.configure()
        for workspace in self.workspaces:
            (workspace / "stop-mode").write_text("terminal")
        self.start(configured=True)
        for path in self.paths:
            assert self.request(path + "/messages", "POST", {
                "client_message_id": "synthetic:1", "text": "synthetic ordinary HTTP input"})[0] == 202
        statuses = []
        for index in range(2):
            def ready():
                status = self.status(index, "running")
                return status if status and status["progress"] and status["capabilities"]["stop"] else None
            statuses.append(wait_for(ready, "independent ordinary native progress"))
        assert statuses[0]["run_id"] != statuses[1]["run_id"]
        assert len({row["pid"] for row in self.trace()}) == 2
        assert len({row["pid_namespace"] for row in self.trace()}) == 2
        roots = [self.home / "owned-executions" / item for item in self.conversations]
        assert all((root / "home").is_dir() and (root / "tmp").is_dir() for root in roots)
        assert not (self.home / "owned-execution").exists()
        return statuses


def stop_request(status, key):
    return {"run_id": status["run_id"], "expected_revision": status["revision"],
            "expected_control_revision": status["control_revision"], "request_key": key}


def independent_controls(case):
    statuses = case.both_running()
    # Ordinary project creation cannot borrow an already configured provider.
    code, project, _ = case.request("/api/v2/projects", "POST", {
        "client_request_id": "unconfigured-conversation", "name": "Synthetic unconfigured project"})
    assert code == 201
    unconfigured = f"/api/v2/conversations/{project['conversation_id']}"
    unknown = f"/api/v2/conversations/{uuid.uuid4()}"
    assert case.request(unconfigured + "/execution")[0] == 204
    for path, expected in [(unconfigured, 503), (unknown, 404)]:
        assert case.request(path + "/workers")[0] == expected
        # Durable reads still reject a run from another conversation.
        for suffix in ["/worker-tasks?parent_run_id=" + statuses[0]["run_id"],
                       "/execution?run_id=" + statuses[0]["run_id"]]:
            assert case.request(path + suffix)[0] == 404, suffix
        assert case.request(path + "/stop", "POST", stop_request(statuses[0], "no-fallback"))[0] == expected
    # Owner evidence is durable even where no execution factory is configured.
    # Live authority routes above still refuse; another scope stays unknown.
    code, held, _ = case.request(unconfigured + "/held-inputs")
    assert code == 200 and held["schema_version"] == 1
    assert held["conversation_id"] == project["conversation_id"]
    assert held["held"] == [] and held["next_after_sequence"] is None
    assert not held["eligible_input_available"]
    assert case.request(unknown + "/held-inputs")[0] == 404
    assert case.request(unconfigured + "/messages", "POST", {
        "client_message_id": "synthetic:unconfigured", "text": "synthetic durable owner input"})[0] == 202
    code, after, _ = case.request(unconfigured + "/held-inputs")
    assert code == 200 and after["conversation_id"] == project["conversation_id"]
    assert after["held"] == [] and after["eligible_input_available"]
    code, queued, _ = case.request(unconfigured + "/execution")
    assert code == 200 and queued["phase"] == "queued" and queued["run_id"] is None
    assert queued["capabilities"] == {"stop": False, "steer": False}
    for index in range(2):
        own, foreign = statuses[index], statuses[1-index]
        path = case.paths[index]
        assert case.request(path + "/execution?run_id=" + own["run_id"])[0] == 200
        assert case.request(path + "/execution?run_id=" + foreign["run_id"])[0] == 404
        assert case.request(path + "/stop", "POST", stop_request(foreign, "cross-scope"))[0] == 503
        assert case.request(path + "/workers")[0] == 200
        assert case.request(path + "/held-inputs")[0] == 200
        assert case.request(path + "/messages", "POST", {
            "client_message_id": "synthetic:2", "text": "synthetic ordinary HTTP input 2"})[0] == 202
    assert not any(row["kind"] == "interrupt" for row in case.trace())
    for index in range(2):
        running = case.status(index, "running")
        assert running and running["capabilities"]["stop"]
        body = stop_request(running, f"stop-only-{index}")
        code, receipt, _ = case.request(case.paths[index] + "/stop", "POST", body)
        assert code == 200 and receipt["conversation_id"] == case.conversations[index]
        wait_for(lambda: any(row["kind"] == "interrupt-ack" for row in case.trace_for(index)),
                 "exact conversation native interruption")
        (case.workspaces[index] / "release-stop").touch()
        wait_for(lambda: case.status(index, "cancelled"), "exact conversation terminal")
        wait_for(case.probes[index].gone, "selected native child reaped")
        assert case.request(case.paths[index] + "/stop", "POST", body)[:2] == (200, receipt)
        if index == 0:
            sibling = case.status(1, "running")
            assert sibling and sibling["run_id"] == statuses[1]["run_id"] and sibling["capabilities"]["stop"]
            assert not case.probes[1].gone()
            assert not any(row["kind"] == "interrupt" for row in case.trace_for(1))
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == 2
        assert db.execute("SELECT count(DISTINCT context_id) FROM production_runs").fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM production_held_inputs").fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM production_observations WHERE kind='stopped'").fetchone()[0] == 2
    for index in range(2):
        trace = case.trace_for(index)
        assert sum(row["kind"] == "turn" for row in trace) == 1
        assert sum(row["kind"] == "interrupt" for row in trace) == 1


def joined_shutdown(case):
    case.both_running()
    for workspace in case.workspaces:
        (workspace / "release-stop").touch()
    process = case.process
    case.stop()
    assert process.returncode == 0, "ordinary joined cleanup must exit without forced termination"
    wait_for(case.peer_gone, "all configured native children must be reaped")
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_runs").fetchone()[0] == 2
        assert db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0] == 2


def refused(case, kind):
    case.stop()
    case.configure()
    if kind == "duplicate_conversation":
        case.manifest["configurations"][1] = case.manifest["configurations"][0]
    elif kind == "capacity":
        case.manifest["configurations"] *= 9
    elif kind == "authority_field":
        case.manifest["provider_auth"] = "synthetic-forbidden-authority"
    elif kind == "duplicate_supervisor":
        file = case.root / "second-execution.json"
        second = json.loads(file.read_text())
        second.update(namespace="synthetic:local", supervisor_key="synthetic-http")
        write_private(file, second)
    else:
        raise AssertionError("unknown refusal case")
    write_private(case.root / "execution-set.json", case.manifest)
    case.start(configured=True, refused=True)
    assert not any((workspace / "synthetic-peer.jsonl").exists() for workspace in case.workspaces)
    with sqlite3.connect(case.home / "core.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM production_supervisors").fetchone()[0] == 0


def main():
    cases = [("independent_controls", independent_controls), ("joined_shutdown", joined_shutdown)]
    cases.extend((kind, lambda case, kind=kind: refused(case, kind)) for kind in
                 ["duplicate_conversation", "duplicate_supervisor", "capacity", "authority_field"])
    for name, operation in cases:
        case = GroupCase()
        try:
            case.setup()
            operation(case)
            print("case passed:", name, flush=True)
        finally:
            case.cleanup()


if __name__ == "__main__":
    main()
