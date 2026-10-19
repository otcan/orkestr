"""Dropped-UID persistent server exec; parent-death fence precedes exec."""
import ctypes
import os
from pathlib import Path
import signal
import sys


def main(parent_text):
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    from codex_service.package import Package
    from codex_service.contract import require
    require(parent_text.isdigit(), "server_parent_required")
    parent = int(parent_text)
    libc = ctypes.CDLL(None, use_errno=True)
    require(parent > 1 and os.getppid() == parent and
            libc.prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == parent,
            "server_parent_death")
    package = Package(root)
    require(os.geteuid() == package.uid, "server_executor_identity")
    with open(package.runtime["bootstrap_file"], "rb") as stream:
        bootstrap = stream.read(257)
    require(32 <= len(bootstrap) <= 256 and all(c in
            b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in bootstrap),
            "private_bootstrap_format")
    environment = package.environment()
    environment["ORKESTR_V2_BOOTSTRAP_TOKEN"] = bootstrap.decode("ascii")
    os.execve(str(root / "server"), [str(root / "server")], environment)


if __name__ == "__main__":
    try:
        raise RuntimeError("use the verified no-site entry")
    except Exception:
        sys.stderr.write("selected Codex service server refused\n")
        raise SystemExit(2)
