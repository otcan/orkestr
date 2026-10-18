"""Required bounded synthetic namespace probe; no provider or account access."""
import os
import subprocess
import sys
import tempfile

binary = "/usr/bin/bwrap"
if not os.path.isfile(binary) or not os.access(binary, os.X_OK):
    sys.exit("missing executable prerequisite: /usr/bin/bwrap")
# File-backed output avoids unbounded pipe buffering from a broken executable.
with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
    try:
        result = subprocess.run(
            [binary, "--unshare-user", "--unshare-pid", "--die-with-parent",
             "--bind", "/", "/", "--proc", "/proc", "--",
             "/usr/bin/python3", "-c",
             "print('namespace-ready')"],
            env={}, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
            timeout=2, check=False,
        )
    except subprocess.TimeoutExpired:
        sys.exit("namespace readiness timed out after 2s; owned probe killed and waited")
    out.seek(0)
    err.seek(0)
    stdout, stderr = out.read(4096), err.read(4096)
    if result.returncode != 0 or stdout != b"namespace-ready\n":
        sys.exit(f"namespace startup refused: returncode={result.returncode} "
                 f"stdout={stdout!r} stderr={stderr!r}")
print("namespace-ready")
