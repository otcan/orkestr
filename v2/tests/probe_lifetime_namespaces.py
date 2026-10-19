"""Fail closed with startup diagnostics before actual namespace cleanup tests."""
import pathlib
import subprocess
import sys


def main():
    executable = pathlib.Path("/usr/bin/bwrap")
    if not executable.is_file():
        raise SystemExit("missing prerequisite: /usr/bin/bwrap (install bubblewrap)")
    command = [str(executable), "--unshare-user", "--unshare-pid",
               "--die-with-parent", "--bind", "/", "/", "--proc", "/proc",
               "--", "/usr/bin/python3", "-c",
               "print('orkestr-lifetime-namespace-ready', flush=True)"]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired as error:
        raise SystemExit(f"namespace startup exceeded 10s: {error}") from error
    if result.returncode or result.stdout.strip() != "orkestr-lifetime-namespace-ready":
        sys.stderr.write(f"namespace prerequisite failed: exit={result.returncode}\n")
        sys.stderr.write(result.stderr[:8192])
        sys.stderr.write(result.stdout[:8192])
        raise SystemExit("Bubblewrap exists; inspect startup diagnostics for namespace denial or launch failure")
    print("Bubblewrap user/PID namespace startup passed; cleanup tests remain required")


if __name__ == "__main__":
    main()
