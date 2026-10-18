#!/usr/bin/python3
"""Owned ordinary HTTP fixture bridge; fixed synthetic peers, no provider account."""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import sys
import time
from unittest.mock import patch


def main():
    assert len(sys.argv) == 5, "fixture_arguments_required"
    binary, ui, source = (Path(value).resolve(strict=True) for value in sys.argv[1:4])
    mode = sys.argv[4]
    assert mode in ("tasks", "stop", "ack-only", "held", "logout")
    sys.argv = [sys.argv[0], str(binary)]
    sys.path.insert(0, str(source / "v2/tests"))
    from worker_tasks_http import TaskCase, ordinary
    from owned_native_probe import process_start

    class BrowserCase(TaskCase):
        def stop(self):
            process = self.process
            try:
                super().stop()
            finally:
                # Older fixture sources can raise in their identity oracle.
                # That must still clean this exact Popen-owned server.
                if process is not None:
                    if process.poll() is None:
                        process.send_signal(signal.SIGINT)
                        try:
                            process.wait(timeout=5)
                        except ordinary.subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=3)
                    process.stderr.close()
                    self.process = None

        def start(self, configured=False, refused=False):
            # Reuse the source-pinned listener-ownership and readiness checks.
            # Only add the reviewed static bundle to this exact server's env.
            original = ordinary.subprocess.Popen

            def launch(argv, *args, **kwargs):
                assert argv == [str(binary)], "unexpected_fixture_executable"
                environment = dict(kwargs["env"])
                assert "ORKESTR_V2_UI_DIST" not in environment
                environment["ORKESTR_V2_UI_DIST"] = str(ui)
                kwargs["env"] = environment
                return original(argv, *args, **kwargs)

            with patch.object(ordinary.subprocess, "Popen", launch):
                super().start(configured, refused)

        def configure(self):
            super().configure()
            launcher = self.root / "synthetic-launcher"
            launcher.write_text(launcher.read_text().replace("#!/usr/bin/python3\n", "#!/usr/bin/python3 -B\n", 1))
            configuration = self.root / "execution.json"
            configured = json.loads(configuration.read_text())
            configured["launcher_sha256"] = hashlib.sha256(launcher.read_bytes()).hexdigest()
            configuration.write_text(json.dumps(configured))
            if mode == "ack-only":
                (self.workspace / "worker-ack-only").touch()
            if mode == "stop":
                (self.workspace / "worker-late-progress").touch()

        def peer_gone(self):
            self.trace()
            # Never reuse provider namespace PIDs as host signal/identity proof.
            return self.native_probe.gone() and not any(self.home.rglob("worker-*"))

        def metadata(self):
            trace = self.trace()  # observe host identities before terminal actions
            runs = self.runs()
            parent = next((row for row in runs if row["role"] == "deep"), None)
            tasks = []
            if parent:
                self.parent = parent
                tasks = self.task_list()["tasks"]
            return {
                "runs": [{key: row[key] for key in ("id", "role", "state", "session_id")}
                         for row in runs],
                "tasks": [{"task_id": row["task"]["task_id"], "phase": row["phase"],
                           "run_id": row["run_id"], "title": row["title"],
                           "instructions_available": row["instructions_available"]}
                          for row in tasks],
                "trace": [{"kind": row["kind"], "role": row["role"],
                           "native_hash": hashlib.sha256(row["native"].encode()).hexdigest(),
                           **({"task": row["task"]} if "task" in row else {})}
                          for row in trace if row["kind"] in ("spawn", "turn", "interrupt", "completed")],
                "owned_native_count": len(self.native_probe.identities),
                "owned_native_alive": sum(process_start(pid) == start
                                          for pid, start in self.native_probe.identities.values()),
            }

    def emit(value):
        print(json.dumps(value, separators=(",", ":")), flush=True)

    def interrupted(_signum, _frame):
        raise InterruptedError("fixture_interrupted")

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    case = BrowserCase()
    server_identities = []
    result = "failed"
    try:
        case.setup()
        server_identities.append((case.process.pid, process_start(case.process.pid)))
        case.stop()
        case.configure()
        case.start(configured=True)
        server_identities.append((case.process.pid, process_start(case.process.pid)))
        emit({"ready": True, "origin": case.origin, "conversation": case.conversation})
        deadline = time.monotonic() + 90
        pending = b""
        while time.monotonic() < deadline:
            if b"\n" not in pending:
                if not select.select([sys.stdin], [], [], 0.1)[0]:
                    continue
                chunk = os.read(sys.stdin.fileno(), 4097)
                if not chunk:
                    assert not pending, "fixture_request_truncated"
                    break
                pending += chunk
                assert len(pending) <= 16384, "fixture_request_buffer_bound"
                if b"\n" not in pending:
                    assert len(pending) <= 4096, "fixture_request_bound"
                    continue
            raw, pending = pending.split(b"\n", 1)
            assert len(raw) < 4096, "fixture_request_bound"
            request = json.loads(raw)
            assert set(request) <= {"id", "method", "name"}
            assert type(request["id"]) is int and 0 < request["id"] < 10000
            method = request["method"]
            if method == "close":
                result = "closed"
                break
            if method == "summary":
                value = case.metadata()
            elif method == "barrier":
                name = request["name"]
                assert name in ("progress-after-status", "release-alpha", "release-beta", "release-deep")
                case.trace()
                (case.workspace / name).touch()
                value = {"applied": name}
            else:
                raise AssertionError("unknown_fixture_method")
            emit({"id": request["id"], "value": value})
        else:
            raise AssertionError("fixture_lifetime_exceeded")
    except BaseException as error:
        emit({"error": type(error).__name__,
              "detail_sha256": hashlib.sha256(str(error).encode()).hexdigest()})
        raise
    finally:
        # An abort cannot interrupt bounded cleanup halfway through.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        observed = None
        try:
            if case.process is not None:
                try:
                    observed = case.metadata()
                except Exception:
                    pass  # Preserve the first failure; this cannot skip cleanup.
        finally:
            case.cleanup()
        assert all(process_start(pid) != start for pid, start in server_identities)
        assert case.native_probe.gone(), "owned_native_cleanup_unconfirmed"
        emit({"closed": True, "result": result, "summary": observed,
              "cleanup": {"servers_gone": True, "native_identities_gone": True,
                          "synthetic_state_removed": not case.root.exists()}})


if __name__ == "__main__":
    main()
