"""Fixed exec shim: parent-death signal is installed after dropping privileges."""
import ctypes
import os
from pathlib import Path
import signal
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    from codex_bounded.configuration import Package
    from codex_bounded.trust import require
    require(len(sys.argv) == 2 and sys.argv[1].isdigit(), "server_parent_required")
    parent = int(sys.argv[1])
    require(parent > 1 and os.getppid() == parent, "server_parent_changed")
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == parent,
            "server_parent_death_fence")
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
        main()
    except Exception:
        sys.stderr.write("selected Codex server refused\n")
        raise SystemExit(2)
