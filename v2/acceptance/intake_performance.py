"""Bounded loopback intake baseline; never a provider/browser/full-release gate."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import secrets
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

CLIENTS, WARMUP, INTAKE, HISTORY, PAGES = 10, 50, 300, 10_000, 100
TEXT = "Synthetic intake performance message. No provider execution."
PENDING = ["provider execution latency", "ordinary Stop fencing and latency",
           "normal-access browser thread load", "busy composer responsiveness",
           "resource polling impact", "candidate and full-release qualification"]


class CheckpointFailure(Exception):
    pass


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def percentile(values, percent):
    """Nearest rank: sorted values[ceil(p*N/100)-1], without interpolation."""
    return sorted(values)[math.ceil(percent * len(values) / 100) - 1] if values else None


def summary(samples, expected, threshold_ms):
    durations = [row["duration_ns"] / 1_000_000 for row in samples]
    errors = sum(not row["ok"] for row in samples)
    p95 = percentile(durations, 95)
    return {"expected": expected, "attempted": len(samples), "errors": errors,
            "http_status_counts": {str(code): sum(row["status"] == code for row in samples)
                                   for code in set(row["status"] for row in samples)},
            "p50_ms": percentile(durations, 50), "p95_ms": p95,
            "p99_ms": percentile(durations, 99), "threshold_ms_exclusive": threshold_ms,
            "passed": len(samples) == expected and errors == 0 and p95 is not None
            and p95 < threshold_ms}


def require(condition, sample=None, reason="protocol_validation_failed"):
    if not condition:
        if sample is not None:
            sample.update(ok=False, error=reason)
        raise CheckpointFailure(reason)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class OwnedServer:
    def __init__(self, binary, root, budget):
        self.binary, self.root = binary, root
        self.started, self.deadline = time.monotonic(), time.monotonic() + budget
        self.samples, self.process, self.token = [], None, None
        self.lock, self.process_lock, self.local = threading.Lock(), threading.Lock(), threading.local()
        self.expired = threading.Event()
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.env = {"HOME": str(root), "LANG": "C", "ORKESTR_V2_HOME": str(root / "state"),
                    "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}", "ORKESTR_V2_ORIGIN": self.base,
                    "ORKESTR_V2_BOOTSTRAP_TOKEN": secrets.token_hex(32)}
        self.timer = threading.Timer(budget, self.expire)
        self.timer.daemon = True
        self.timer.start()

    def expire(self):
        self.expired.set()
        self.stop(kill=True)

    def check(self):
        require(not self.expired.is_set() and time.monotonic() < self.deadline,
                reason="wall_time_budget_exhausted")

    def start(self):
        with self.process_lock:
            self.check()
            self.process = subprocess.Popen([str(self.binary)], cwd=self.root, env=self.env,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            process = self.process
        deadline, output = min(self.deadline, time.monotonic() + 10), b""
        marker = f" home={self.root / 'state'} bind=127.0.0.1:{self.port} ".encode()
        while not any(line.startswith(b"orkestr-v2-server ") and marker in line
                      and line.endswith(b"execution=disabled connections=none")
                      for line in output.splitlines()):
            self.check()
            require(process.poll() is None and time.monotonic() < deadline,
                    reason="owned_server_not_ready")
            if select.select([process.stderr], [], [], 0.05)[0]:
                output += os.read(process.stderr.fileno(), 4096)
                require(len(output) <= 16_384, reason="startup_output_limit")
        require(process.poll() is None, reason="owned_server_exited")

    def stop(self, kill=False):
        with self.process_lock:
            if self.process is None:
                return
            if self.process.poll() is None:
                self.process.send_signal(signal.SIGKILL if kill else signal.SIGINT)
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process.stderr.close()
            self.process = None

    def close(self):
        self.timer.cancel()
        self.timer.join(timeout=6)
        self.stop()

    def request(self, phase, path, expected, body=None, extra=None, client=0, index=0):
        self.check()
        if not hasattr(self.local, "opener"):
            self.local.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        headers = {"Content-Type": "application/json", **(extra or {})}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.base + "/api/v2" + path, headers=headers,
                  data=None if body is None else json.dumps(body).encode())
        sample = {"phase": phase, "client": client, "index": index, "status": None,
                  "error": None, "ok": False, "started_offset_ns": int((time.monotonic() - self.started) * 1e9)}
        began, payload = time.perf_counter_ns(), None
        try:
            try:
                response = self.local.opener.open(request, timeout=min(5, self.deadline - time.monotonic()))
            except urllib.error.HTTPError as error:
                response = error
            with response:
                sample["status"] = response.status
                raw = response.read(262_145)
                require(len(raw) <= 262_144, reason="response_size_limit")
                payload = json.loads(raw)
            sample["ok"] = sample["status"] == expected
            if not sample["ok"]:
                sample["error"] = "unexpected_http_status"
        except (OSError, ValueError, CheckpointFailure) as error:
            sample["error"] = type(error).__name__
        finally:
            sample["duration_ns"] = time.perf_counter_ns() - began
            with self.lock:
                self.samples.append(sample)
        require(sample["ok"], sample, sample["error"])
        return sample, payload


def batch(count, action):
    """Ten synchronized closed-loop clients; one outstanding request per client."""
    barrier, failed = threading.Barrier(CLIENTS), threading.Event()

    def worker(client):
        barrier.wait(timeout=5)
        try:
            for index in range(client, count, CLIENTS):
                if failed.is_set():
                    return
                action(client, index)
        except Exception:
            failed.set()
            raise
    with ThreadPoolExecutor(max_workers=CLIENTS) as pool:
        futures = [pool.submit(worker, client) for client in range(CLIENTS)]
        for future in futures:
            future.result()


def admit(server, conversation, phase, count, receipts):
    def action(client, index):
        sample, body = server.request(phase, f"/conversations/{conversation}/messages", 202,
            {"client_message_id": f"{phase}-{index}", "text": TEXT}, client=client, index=index)
        valid = isinstance(body, dict) and body.get("status") == "accepted"
        try:
            uuid.UUID(body["message_id"])
            uuid.UUID(body["event_id"])
            valid = valid and type(body["sequence"]) is int and body["sequence"] > 0
        except (TypeError, ValueError, KeyError):
            valid = False
        require(valid, sample, "invalid_receipt")
        with server.lock:
            require(body["sequence"] not in receipts, sample, "duplicate_receipt_sequence")
            receipts[body["sequence"]] = body["message_id"]
        sample["receipt_sequence"] = body["sequence"]
    batch(count, action)


def verify_history(server, conversation, receipts, phase):
    after, seen = 0, {}
    while True:
        sample, body = server.request(phase, f"/conversations/{conversation}?after={after}&limit=100", 200)
        messages = body.get("messages", []) if isinstance(body, dict) else []
        require(isinstance(messages, list) and 0 < len(messages) <= 100, sample)
        for message in messages:
            sequence = message.get("sequence")
            require(type(sequence) is int and sequence == after + 1
                    and message.get("message_id") == receipts.get(sequence)
                    and message.get("text") == TEXT and message.get("actor_kind") == "owner", sample)
            seen[sequence], after = message["message_id"], sequence
        require(body.get("last_sequence") == len(receipts), sample)
        if body.get("next_cursor") is None:
            break
        require(body["next_cursor"] == after and after < len(receipts), sample)
    require(seen == receipts and len(set(seen.values())) == len(seen), reason="restart_readback_mismatch")


def workload(server):
    server.start()
    sample, health = server.request("setup", "/health", 200)
    require(health.get("fixture_mode") is False and health.get("product") == "orkestr-v2", sample)
    credentials = {"username": "performance-fixture", "password": secrets.token_hex(24)}
    _, setup = server.request("setup", "/setup", 201, credentials,
                             {"x-orkestr-bootstrap": server.env["ORKESTR_V2_BOOTSTRAP_TOKEN"]})
    _, session = server.request("setup", "/machine/session", 200, credentials)
    server.token = session["token"]
    _, project = server.request("setup", "/projects", 201,
                               {"client_request_id": "history", "name": "Synthetic history"})
    conversation, history = setup["global_conversation_id"], project["conversation_id"]
    accepted, historical = {}, {}
    admit(server, conversation, "intake_warmup", WARMUP, accepted)
    admit(server, conversation, "intake", INTAKE, accepted)
    print("Measured intake complete; populating synthetic history.", file=sys.stderr, flush=True)
    admit(server, history, "history_seed", HISTORY, historical)
    require(set(accepted) == set(range(1, WARMUP + INTAKE + 1)))
    require(set(historical) == set(range(1, HISTORY + 1)))
    # Only the owned server is killed. This proves process-restart readback, not
    # power-loss/storage-hardware durability or provider dispatch recovery.
    server.stop(kill=True)
    server.start()
    verify_history(server, conversation, accepted, "restart_verify_intake")
    verify_history(server, history, historical, "restart_verify_history")
    print("Restart readback verified; measuring bounded history pages.", file=sys.stderr, flush=True)
    for name, after in (("first", 0), ("middle", 5000), ("tail", 9950)):
        for index in range(PAGES + 5):
            phase = "history_warmup" if index < 5 else "history_" + name
            sample, body = server.request(phase, f"/conversations/{history}?after={after}&limit=50", 200,
                                          index=index)
            expected = list(range(after + 1, after + 51))
            require(body.get("last_sequence") == HISTORY
                    and [m.get("sequence") for m in body.get("messages", [])] == expected
                    and all(m.get("message_id") == historical.get(m.get("sequence"))
                            and m.get("text") == TEXT for m in body["messages"]), sample)
    return {"status": "passed", "intake_messages": len(accepted), "history_messages": len(historical),
            "method": "owned SIGKILL, same private store reopened, complete HTTP readback"}


def private_directory(path):
    require(path.is_absolute() and not any(p.is_symlink() for p in (path, *path.parents)),
            reason="private_directory_path_invalid")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
            reason="private_directory_must_be_owned_mode_0700")


def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def execute(args):
    require(sys.platform.startswith("linux"), reason="linux_owned_process_probe_required")
    private_directory(args.evidence_dir)
    commit = subprocess.check_output(["git", "-C", str(args.source_checkout), "rev-parse",
                                     args.source_revision + "^{commit}"], text=True).strip()
    require(commit == args.source_revision, reason="exact_source_commit_required")
    lockfile = subprocess.check_output(["git", "-C", str(args.source_checkout), "show",
                                       commit + ":v2/Cargo.lock"])
    run_dir = Path(tempfile.mkdtemp(prefix="run-", dir=args.evidence_dir))
    binary = run_dir / "server"
    with args.binary.open("rb") as source, binary.open("xb") as target:
        shutil.copyfileobj(source, target)
    binary.chmod(0o700)
    require(digest(binary) == args.binary_sha256, reason="pinned_binary_hash_mismatch")
    report = {"format": "orkestr.intake_performance.v1", "scope": "backend_loopback",
              "source_revision_reported": commit, "binary_sha256": args.binary_sha256,
              "cargo_lock_sha256": hashlib.sha256(lockfile).hexdigest(),
              "harness_sha256": digest(__file__), "build_provenance":
              "Caller-attested source/binary relation; a hash alone does not prove the build",
              "started_at": datetime.now(timezone.utc).isoformat(), "pending": PENDING,
              "full_release_qualified": False, "status": "failed", "durability": {"status": "pending"}}
    with tempfile.TemporaryDirectory(prefix="fixture-", dir=run_dir) as root:
        server = OwnedServer(binary, Path(root), args.budget_seconds)
        config = {**server.env, "ORKESTR_V2_BOOTSTRAP_TOKEN": "<ephemeral-redacted>",
                  "clients": CLIENTS, "warmup": WARMUP, "intake_samples": INTAKE,
                  "history_messages": HISTORY, "history_samples_per_position": PAGES,
                  "message_utf8_bytes": len(TEXT.encode()), "wall_time_budget_seconds": args.budget_seconds,
                  "request_timeout_seconds": 5, "logical_cpus": os.cpu_count(),
                  "load_average_at_start": list(os.getloadavg()), "python": platform.python_version(),
                  "percentile": "nearest-rank ceil(p*N/100), all attempted requests including failures",
                  "measurement": "HTTP open through complete bounded body read and JSON decode; fresh TCP",
                  "load_model": "10 synchronized closed-loop clients, one outstanding request each",
                  "history_cache": "warm after restart/full readback and five excluded reads per position"}
        write_private(run_dir / "config.json", json.dumps(config, indent=2) + "\n")
        report["config_sha256"] = digest(run_dir / "config.json")
        try:
            report["durability"] = workload(server)
            require(digest(binary) == args.binary_sha256, reason="binary_changed_during_run")
            report["status"] = "completed"
        except Exception as error:
            report["failure"] = str(error) if isinstance(error, CheckpointFailure) else type(error).__name__
        finally:
            server.close()
            report["duration_seconds"] = time.monotonic() - server.started
            report["raw_samples"] = len(server.samples)
            report["metrics"] = {phase: summary([s for s in server.samples if s["phase"] == phase], count, bound)
                for phase, count, bound in [("intake", INTAKE, 250), ("history_first", PAGES, 2000),
                                           ("history_middle", PAGES, 2000), ("history_tail", PAGES, 2000)]}
            write_private(run_dir / "samples.jsonl", "".join(json.dumps(s) + "\n" for s in server.samples))
    report["owned_process_cleaned"] = server.process is None
    report["synthetic_state_removed"] = not Path(root).exists()
    report["samples_sha256"] = digest(run_dir / "samples.jsonl")
    report["checkpoint_passed"] = report["status"] == "completed" and all(m["passed"] for m in report["metrics"].values())
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    write_private(run_dir / "report.json", json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(run_dir / "report.json"), "checkpoint_passed": report["checkpoint_passed"],
                      "metrics": report["metrics"], "failure": report.get("failure"),
                      "full_release_qualified": False}, indent=2))
    return 0 if report["checkpoint_passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("binary", "source-checkout", "evidence-dir"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--binary-sha256", required=True)
    parser.add_argument("--budget-seconds", type=int, default=180, choices=range(30, 301))
    args = parser.parse_args()
    for value, length in ((args.source_revision, 40), (args.binary_sha256, 64)):
        if len(value) != length or any(c not in "0123456789abcdef" for c in value):
            parser.error("full lowercase source commit and binary SHA256 required")
    if not args.binary.is_absolute() or not args.source_checkout.is_absolute():
        parser.error("binary and source checkout must be absolute")
    try:
        return execute(args)
    except (OSError, subprocess.SubprocessError, CheckpointFailure) as error:
        print("Checkpoint configuration refused: " + type(error).__name__, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
