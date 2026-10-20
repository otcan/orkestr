#!/usr/bin/python3
"""Real Claude provider qualification against an ISOLATED candidate V2 server.

Each scenario creates its own private data home, workspace and loopback port
under <candidate-root>, drives the ordinary authenticated HTTP API and records
only phases, counts and short payload heads under <evidence-dir>. It never
reads or prints credentials; the account directory is passed by reference to
the broker configuration exactly like an installed private config.

  claude_provider_qualification.py --server BIN --broker DIR --executable CLAUDE \
      --account DIR --root DIR --evidence DIR deep auth quota yolo followup

Real model calls cost quota: every prompt is deliberately short. `quota` uses
claude_quota_native.py (installed-CLI rate-limit frame shapes), not a real
exhausted account. Never point --root at a live installation.
"""
import argparse, hashlib, json, os, select, signal, socket, sqlite3, subprocess, time
import urllib.error, urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
for flag in ("server", "broker", "executable", "account", "root", "evidence"):
    parser.add_argument("--" + flag, required=True, type=lambda v: Path(v).resolve())
parser.add_argument("scenarios", nargs="+")
ARGS = parser.parse_args()
binary, broker, root, evidence, account = ARGS.server, ARGS.broker, ARGS.root, ARGS.evidence, ARGS.account
scenarios = ARGS.scenarios
EXECUTABLE = ARGS.executable
QUOTA_NATIVE = Path(__file__).with_name("claude_quota_native.py").resolve()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_a, **_k):
        return None


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
LOG = []


def log(kind, **fields):
    entry = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": kind, **fields}
    LOG.append(entry)
    print(json.dumps(entry), flush=True)


def wait_for(op, what, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        v = op()
        if v:
            return v
        time.sleep(0.2)
    raise AssertionError(what)


class Candidate:
    def __init__(self, name, account_dir):
        self.root = root / name
        self.root.mkdir(mode=0o700, parents=True)
        self.home = self.root / "data"
        self.workspace = root.parent / (root.name + "-ws-" + name)
        for p in (self.home, self.workspace):
            p.mkdir(mode=0o700)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.bootstrap = os.urandom(24).hex()
        self.account = account_dir
        self.process = None
        self.cookie = self.csrf = None
        self.stderr = self.root / "server.stderr"

    def request(self, path, method="GET", body=None, browser=True, extra=None):
        headers = {}
        if browser:
            headers["Origin"] = self.origin
            if self.cookie:
                headers.update({"Cookie": self.cookie, "x-orkestr-csrf": self.csrf})
        headers.update(extra or {})
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        req = urllib.request.Request(self.origin + path, headers=headers, data=data, method=method)
        try:
            reply = opener.open(req, timeout=5)
        except urllib.error.HTTPError as e:
            reply = e
        with reply:
            raw = reply.read()
            return reply.status, (json.loads(raw) if raw else None), reply.headers

    def start(self, configured):
        env = {"PATH": "/usr/bin:/bin", "ORKESTR_V2_HOME": str(self.home),
               "ORKESTR_V2_BIND": f"127.0.0.1:{self.port}", "ORKESTR_V2_ORIGIN": self.origin,
               "ORKESTR_V2_BOOTSTRAP_TOKEN": self.bootstrap}
        if configured:
            env["ORKESTR_V2_EXECUTION_CONFIG"] = str(self.root / "execution.json")
        err = self.stderr.open("ab")
        self.process = subprocess.Popen([str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=err)
        def healthy():
            if self.process.poll() is not None:
                raise AssertionError("server exited: " + self.stderr.read_text()[-2000:])
            try:
                return self.request("/api/v2/health", browser=False)[0] == 200
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                return False
        wait_for(healthy, "health", 30)

    def setup(self):
        self.start(False)
        cred = {"username": "qualification-owner", "password": os.urandom(16).hex()}
        code, body, _ = self.request("/api/v2/setup", "POST", cred, False, {"x-orkestr-bootstrap": self.bootstrap})
        assert code == 201, code
        self.conversation = body["global_conversation_id"]
        code, body, _ = self.request("/api/v2/machine/session", "POST", cred, False)
        self.machine = body["token"]
        self.cred = cred
        self.login()
        self.path = f"/api/v2/conversations/{self.conversation}"

    def login(self):
        code, body, headers = self.request("/api/v2/browser/session", "POST", self.cred)
        assert code == 200
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.csrf = body["csrf_token"]

    def stop_server(self):
        if self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait()
        rc = self.process.returncode if self.process else None
        self.process = None
        return rc

    def configure(self, budget_ms=None, executable=EXECUTABLE, full_access=False):
        nh, nt = self.root / "native-home", self.root / "native-tmp"
        for p in (nh, nt):
            p.mkdir(mode=0o700, exist_ok=True)
        cfg = self.root / "claude-private.json"
        cfg.write_text(json.dumps({"executable": str(executable), "account": str(self.account),
            "workspace": str(self.workspace), "home": str(nh), "temporary": str(nt),
            **({"host_full_access": {"environment": {"HOME": str(nh), "PATH": "/usr/local/bin:/usr/bin:/bin",
                "LANG": "C.UTF-8", "TMPDIR": str(nt)}}} if full_access else {})}))
        cfg.chmod(0o600)
        launcher = self.root / "claude-launcher"
        launcher.write_text("#!/usr/bin/python3\nimport sys\n"
            f"sys.path.insert(0, {str(broker)!r})\nfrom claude_server import main\n"
            f"raise SystemExit(main({str(cfg)!r}))\n")
        launcher.chmod(0o700)
        token = self.root / "machine.token"
        token.write_text(self.machine); token.chmod(0o600)
        value = {"schema_version": 1, "mode": "isolated-acceptance-v1", "provider": "claude",
            "conversation_id": self.conversation, "machine_token_file": str(token),
            "launcher": str(launcher), "launcher_sha256": hashlib.sha256(launcher.read_bytes()).hexdigest(),
            "workspace": str(self.workspace), "namespace": "qualification:claude",
            "supervisor_key": "claude-qualification"}
        if budget_ms:
            value["execution_budget"] = {"max_run_ms": budget_ms}
        ex = self.root / "execution.json"
        ex.write_text(json.dumps(value)); ex.chmod(0o600)

    def status(self):
        code, body, _ = self.request(self.path + "/execution")
        return body if code == 200 else {"phase": None, "http": code}

    def phase_in(self, *phases):
        s = self.status()
        return s if s.get("phase") in phases else None

    def send(self, key, text):
        code, body, _ = self.request(self.path + "/messages", "POST", {"client_message_id": key, "text": text})
        log("message", key=key, http=code)
        return code

    def payload(self, status):
        pid = (status.get("progress") or {}).get("payload_id")
        if not pid:
            return None
        code, body, _ = self.request(self.path + "/payloads/" + pid)
        return body.get("text") if code == 200 else None

    def completion_event(self):
        req = urllib.request.Request(self.origin + self.path + "/events",
                                     headers={"Origin": self.origin, "Cookie": self.cookie})
        found = None
        with opener.open(req, timeout=5) as stream:
            deadline = time.monotonic() + 5
            for line in stream:
                if line.startswith(b"data: "):
                    ev = json.loads(line[6:])
                    obs = ev["payload_ref_or_safe_payload"].get("observation", {})
                    if obs.get("kind") == "completed_proposal":
                        found = ev["event_id"]
                if time.monotonic() > deadline:
                    break
                if found and not select.select([stream.fp], [], [], 0.3)[0]:
                    break
        return found

    def accept(self, status, key):
        completion = (status.get("acceptance_candidate") or {}).get("completion_event_id") or self.completion_event()
        body = {"run_id": status["run_id"], "completion_event_id": completion,
                "expected_revision": status["revision"], "request_key": key}
        code, receipt, _ = self.request(self.path + "/accept", "POST", body)
        log("accept", http=code, outcome=(receipt or {}).get("outcome"))
        return code, receipt

    def db(self, query):
        with sqlite3.connect(f"file:{self.home / 'core.sqlite3'}?mode=ro", uri=True) as d:
            return d.execute(query).fetchall()

    def natives(self):
        return self.db("SELECT requested_native_id, observed_run_id IS NOT NULL FROM production_requested_native")

    def claude_children(self):
        out = subprocess.run(["pgrep", "-f", "-a", str(EXECUTABLE)], capture_output=True, text=True).stdout
        return [l.split()[0] for l in out.splitlines() if str(self.workspace) in Path(f"/proc/{l.split()[0]}/cwd").resolve().as_posix()] if out else []

    def summary(self, s):
        return {k: s.get(k) for k in ("phase", "run_id", "revision", "capabilities", "failure")} | {
            "has_progress": bool(s.get("progress")), "has_candidate": bool(s.get("acceptance_candidate"))}


def turn(c, key, text, accept=True, timeout=90):
    previous = c.status().get("run_id")
    assert c.send(key, text) == 202
    def fresh():
        s = c.phase_in("awaiting_acceptance", "failed", "blocked", "cancelled")
        return s if s and s.get("run_id") != previous else None
    s = wait_for(fresh, f"{key} proposal", timeout)
    text_out = c.payload(s)
    log("proposal", key=key, status=c.summary(s), payload_chars=len(text_out or ""), payload_head=(text_out or "")[:80])
    if accept and s["phase"] == "awaiting_acceptance":
        code, receipt = c.accept(s, "accept:" + key)
        assert code == 200 and receipt["outcome"] == "succeeded", (code, receipt)
        wait_for(lambda: c.phase_in("completed"), "completed after accept", 30)
    return s, text_out


def deep(c):
    """Fresh -> resume continuation -> restart recovery -> Stop -> post-Stop resume."""
    c.setup(); c.stop_server(); c.configure(); c.start(True)
    log("scenario", name="fresh")
    s1, t1 = turn(c, "q1", "Remember the codeword AMBER. Reply with exactly: pong")
    assert s1["phase"] == "awaiting_acceptance" and "pong" in (t1 or "").lower()
    natives = c.natives(); log("natives", rows=natives)
    log("scenario", name="resume")
    s2, t2 = turn(c, "q2", "What codeword did I give you? Reply with the single word only.")
    assert "amber" in (t2 or "").lower(), t2
    assert len({r[0] for r in c.natives()}) == 1, "same native session across accepted turns"
    log("scenario", name="restart")
    rc = c.stop_server(); log("server_stopped", rc=rc, claude_children=c.claude_children())
    c.start(True)
    s3, t3 = turn(c, "q3", "Repeat the codeword once more, single word.")
    assert "amber" in (t3 or "").lower(), t3
    assert len({r[0] for r in c.natives()}) == 1
    log("scenario", name="stop")
    assert c.send("q4", "Write a detailed 1500-word essay about the history of lighthouses.") == 202
    def stoppable():
        s = c.status()
        return s if s.get("phase") == "running" and s.get("capabilities", {}).get("stop") else (
            s if s.get("phase") in ("awaiting_acceptance", "failed", "blocked") else None)
    s4 = wait_for(stoppable, "running with stop", 60)
    log("running", status=c.summary(s4))
    assert s4["phase"] == "running", s4["phase"]
    code, rec, _ = c.request(c.path + "/stop", "POST", {"run_id": s4["run_id"], "expected_revision": s4["revision"],
        "expected_control_revision": s4.get("control_revision"), "request_key": "stop:q4"})
    log("stop", http=code, body=rec if code != 200 else {k: rec.get(k) for k in ("outcome", "phase")})
    s5 = wait_for(lambda: c.phase_in("cancelled", "failed", "blocked", "completed") or (
        c.phase_in("cancel_requested") if False else None), "stop terminal", 40)
    log("stopped", status=c.summary(s5), observations=c.db("SELECT kind FROM production_observations ORDER BY rowid DESC LIMIT 3"))
    log("scenario", name="post_stop_resume")
    s6, t6 = turn(c, "q5", "Reply with exactly: ok")
    assert "ok" in (t6 or "").lower()
    log("natives_final", rows=c.natives())


def auth(c):
    """Empty CLAUDE_CONFIG_DIR: must fail truthfully, never fall back."""
    c.setup(); c.stop_server(); c.configure(); c.start(True)
    assert c.send("a1", "Reply with exactly: pong") == 202
    def settled():
        s = c.status()
        return s if s.get("phase") not in (None, "queued", "starting", "running") else None
    try:
        s = wait_for(settled, "auth failure surfaces", 60)
    except AssertionError:
        s = c.status()
    log("auth_status", status=c.summary(s), payload=(c.payload(s) or "")[:160],
        observations=c.db("SELECT kind FROM production_observations"))
    assert s["phase"] == "failed" and not s.get("progress")
    assert s.get("failure") == {"class": "authentication"}, s.get("failure")


def quota(c):
    """Synthetic native with real CLI rate-limit shapes (real exhaustion not induced)."""
    c.setup(); c.stop_server(); c.configure(executable=QUOTA_NATIVE); c.start(True)
    assert c.send("r1", "Reply with exactly: pong") == 202
    s = wait_for(lambda: c.phase_in("failed", "blocked", "awaiting_acceptance", "completed"), "quota failure surfaces", 30)
    log("quota_status", status=c.summary(s), observations=c.db("SELECT kind FROM production_observations"))
    assert s["phase"] == "failed" and not s.get("progress")
    assert s.get("failure") == {"class": "quota"}, s.get("failure")


def yolo(c):
    """Operator full access: real tool use on the host, then Stop during a tool call."""
    c.setup(); c.stop_server(); c.configure(full_access=True); c.start(True)
    s, t = turn(c, "y1", "Use the Bash tool to run exactly: id -un; sudo -n true && echo sudo-ok; "
                "echo tool-ran > proof.txt. Then reply with only the two output lines.")
    assert s["phase"] == "awaiting_acceptance" and "sudo-ok" in (t or ""), t
    assert (c.workspace / "proof.txt").read_text().strip() == "tool-ran"
    log("scenario", name="yolo_resume")
    s2, t2 = turn(c, "y2", "Which file did you create in the previous turn? Reply with the file name only.")
    assert "proof.txt" in (t2 or ""), t2
    log("scenario", name="yolo_stop_in_tool")
    assert c.send("y3", "Use the Bash tool to run: sleep 30. Then say done.") == 202
    s3 = wait_for(lambda: c.phase_in("running") if (c.status().get("capabilities") or {}).get("stop") else None, "running", 60)
    time.sleep(6)
    code, rec, _ = c.request(c.path + "/stop", "POST", {"run_id": s3["run_id"], "expected_revision": c.status()["revision"],
        "expected_control_revision": c.status().get("control_revision"), "request_key": "stop:y3"})
    log("stop", http=code)
    s4 = wait_for(lambda: c.phase_in("cancelled", "failed", "blocked", "cancel_requested"), "stop terminal", 40)
    s4 = wait_for(lambda: c.phase_in("cancelled", "failed", "blocked"), "stop settled", 20) if s4["phase"] == "cancel_requested" else s4
    log("stopped", status=c.summary(s4), observations=c.db("SELECT kind FROM production_observations ORDER BY rowid DESC LIMIT 3"),
        leftover_sleep=subprocess.run(["pgrep", "-f", "sleep 30"], capture_output=True, text=True).stdout.split())
    assert s4["phase"] == "cancelled"


def followup(c):
    """Follow-up while busy stays durably queued, then runs once after acceptance."""
    c.setup(); c.stop_server(); c.configure(); c.start(True)
    assert c.send("f1", "Write three sentences about tides.") == 202
    wait_for(lambda: c.phase_in("running"), "running", 60)
    assert c.send("f2", "Now reply with exactly: second") == 202
    s = wait_for(lambda: c.phase_in("awaiting_acceptance"), "first proposal", 90)
    inbox = c.db("SELECT state FROM reasoning_inbox ORDER BY rowid")
    log("busy", status=c.summary(s), inbox=inbox, runs=c.db("SELECT count(*) FROM production_runs"))
    assert c.db("SELECT count(*) FROM production_runs") == [(1,)]
    code, receipt = c.accept(s, "accept:f1")
    assert code == 200
    def second():
        x = c.phase_in("awaiting_acceptance")
        return x if x and x["run_id"] != s["run_id"] else None
    s2 = wait_for(second, "follow-up dispatched after acceptance", 90)
    t2 = c.payload(s2)
    log("followup", status=c.summary(s2), payload_head=(t2 or "")[:40], runs=c.db("SELECT count(*) FROM production_runs"))
    assert "second" in (t2 or "").lower()


def main():
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in scenarios:
        acct = account if name != "auth" else (root / "empty-account")
        acct.mkdir(mode=0o700, exist_ok=True)
        c = Candidate(name, acct)
        ok = False
        try:
            globals()[name](c); ok = True
        except Exception as e:
            log("failure", scenario=name, error=repr(e)[:600])
        finally:
            c.stop_server()
            log("result", scenario=name, passed=ok, leftover_claude=c.claude_children())
            (evidence / f"{name}.jsonl").write_text("\n".join(json.dumps(x) for x in LOG) + "\n")
            tail = c.stderr.read_text()[-4000:] if c.stderr.exists() else ""
            (evidence / f"{name}.server-stderr.txt").write_text(tail)
            LOG.clear()


main()
