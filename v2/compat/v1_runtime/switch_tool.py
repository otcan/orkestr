"""orkestr-model-switch invocation and output parsing for `/switch` (see switch_command.py).

The tool path comes only from the service environment and must be a root-owned
executable nobody else can rewrite; it is run with an argument list, a fixed
environment and a timeout, never through a shell.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

# Deployment paths come from the service environment (e.g. a systemd drop-in);
# without them /switch answers that switching is not configured here.
TOOL_ENV = "ORKESTR_V2_ADAPTER_MODEL_SWITCH"
RECORDS_ENV = "ORKESTR_V2_ADAPTER_MODEL_SWITCH_RECORDS"
TIMEOUTS = {"status": 45, "dry": 90, "apply": 180}
PLAN_ROW = re.compile(r"^  (.+?)\s+(\S+) -> (\S+)(.*)$")


class Switcher:
    """Runs orkestr-model-switch with an argument list; `run` is replaceable in tests."""

    def __init__(self, tool=None, records=None, run=None):
        self.tool = tool or os.environ.get(TOOL_ENV) or ""
        self.records = Path(records or os.environ.get(RECORDS_ENV) or "/nonexistent")
        self._run = run

    def trusted(self):
        """The tool must be a root-owned regular file nobody else can rewrite."""
        try:
            info = os.stat(self.tool)
        except OSError:
            return False
        return (os.path.isabs(self.tool) and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                not info.st_mode & 0o022 and info.st_mode & 0o100)

    def call(self, args, kind):
        if self._run is not None:
            return self._run(list(args), kind)
        if not self.trusted():
            return 127, "", "model switching is not configured on this host (%s)" % TOOL_ENV
        try:
            done = subprocess.run([self.tool] + list(args), capture_output=True, text=True, timeout=TIMEOUTS[kind],
                                  stdin=subprocess.DEVNULL, close_fds=True,
                                  env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"})
        except subprocess.TimeoutExpired:
            return 124, "", "timed out"
        except OSError as error:
            return 126, "", "could not run the tool (%s)" % type(error).__name__
        return done.returncode, done.stdout, done.stderr

    def status(self):
        code, out, err = self.call(["--status", "--json"], "status")
        if code != 0:
            raise RuntimeError(first_line(err) or "status failed (%d)" % code)
        return json.loads(out)

    def history(self):
        """Switch records, newest first (unreadable ones are skipped)."""
        out = []
        try:
            paths = sorted(self.records.glob("*.json"))
        except OSError:
            return out
        for path in paths:
            try:
                value = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(value, dict):
                value.setdefault("record", path.stem)
                out.append(value)
        return sorted(out, key=lambda r: (str(r.get("at") or ""), str(r.get("record"))), reverse=True)


def first_line(text):
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line[:300]
    return ""


def reason(err, code):
    line = first_line(err)
    for prefix in ("refused: ", "V2 API error: "):
        if line.startswith(prefix):
            return line[len(prefix):]
    return line or "exit %d" % code


def plan_lines(out):
    """(header, [change lines]) from the tool's plan output."""
    header, lines = None, []
    for raw in (out or "").splitlines():
        if raw.startswith("plan:") and header is None:
            header = raw[5:].strip()
        elif header is not None:
            # "  <name padded to 40> <before> -> <after>[  [note]]"; values have no spaces.
            match = PLAN_ROW.match(raw)
            if match:
                lines.append("%s: %s → %s%s" % (match[1].strip(), match[2], match[3], match[4].rstrip()))
    return header, lines


def planned_count(header):
    match = re.search(r"for (\d+) (?:conversation|thread)", header or "")
    return int(match.group(1)) if match else None


def log(conversation, args, code, note=""):
    safe = " ".join(a if re.match(r"^[A-Za-z0-9._:/=-]{1,160}$", a) else json.dumps(a) for a in args)
    print("SWITCH orkestr-v2-wa-adapter conversation=%s exit=%s args=%s%s"
          % (conversation, code, safe, (" " + note) if note else ""), file=sys.stderr, flush=True)
