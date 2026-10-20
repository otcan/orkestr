"""Fixed command-only subreaper. No provider credentials, protocol or authority.

Runtime owns this original Child outside the job cgroup. Only bwrap and its
descendants enter that cgroup; after cgroup.kill this process retains waitpid
ownership through ECHILD, including setsid/double-fork descendants.
"""
import ctypes
import os
import signal
import stat
import struct
import subprocess
import sys


def arguments(policy, image, workspace, command):
    return [
        "/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-net",
        "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--disable-userns",
        "--assert-userns-disabled", "--die-with-parent", "--new-session",
        "--cap-drop", "ALL", "--clearenv",
        "--ro-bind-fd", str(image), "/", "--bind-fd", str(workspace), "/workspace",
        "--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev",
        "--size", "16777216", "--tmpfs", "/dev/shm", "--remount-ro", "/dev",
        "--size", "67108864", "--tmpfs", "/tmp",
        "--size", "16777216", "--tmpfs", "/home/worker", "--chdir", "/workspace",
        "--setenv", "HOME", "/home/worker", "--setenv", "PATH", "/usr/bin:/bin",
        "--setenv", "PWD", "/workspace", "--setenv", "TMPDIR", "/tmp",
        "--setenv", "LANG", "C.UTF-8", "--seccomp", str(policy),
        "--", "/bin/sh", "-c", command,
    ]


def run(argv):
    if len(argv) != 7 or argv[5] != "--":
        raise ValueError("fixed command operation required")
    fds = tuple(int(value) for value in argv[:5])
    if len(set(fds)) != 5 or any(fd < 3 for fd in fds):
        raise ValueError("distinct retained descriptors required")
    policy, image, workspace, cgroup, ready = fds
    os.set_inheritable(ready, False)
    command = argv[6]
    if not 0 < len(command.encode()) <= 32768 or "\0" in command:
        raise ValueError("command bound")
    if not all(stat.S_ISDIR(os.fstat(fd).st_mode) for fd in (image, workspace)):
        raise ValueError("retained directories required")
    if not stat.S_ISREG(os.fstat(policy).st_mode):
        raise ValueError("retained policy required")
    libc = ctypes.CDLL(None, use_errno=True)
    parent = os.getppid()
    if (parent <= 1 or libc.prctl(36, 1, 0, 0, 0) != 0
            or libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent):
        raise RuntimeError("original parent/subreaper unavailable")

    def attach():
        # Single-threaded fork; only this exact child is moved before exec.
        # cgroup FD is CLOEXEC; only mount/policy FDs enter bwrap.
        if os.write(cgroup, b"0") != 1:
            raise OSError("job attach failed")
        os.set_inheritable(cgroup, False)

    child = None
    status = None
    try:
        child = subprocess.Popen(
            arguments(policy, image, workspace, command),
            stdin=subprocess.DEVNULL, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer,
            close_fds=True, pass_fds=fds[:4], preexec_fn=attach,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        os.write(ready, b"R")  # cgroup attach completed before Popen returned.
        for fd in fds[:4]:
            os.close(fd)
        status = child.wait()
    finally:
        if child is not None:
            if status is None:
                child.kill()
                status = child.wait()
            # This process alone is a subreaper. It never waits for unrelated
            # service children and never mistakes an empty proc sample for reap.
            while True:
                try:
                    os.waitpid(-1, 0)
                except InterruptedError:
                    continue
                except ChildProcessError:
                    break
    # The command never inherited this descriptor. ECHILD precedes the witness.
    os.write(ready, b"D" + struct.pack("!i", status))
    os.close(ready)
    return status


def main():
    try:
        status = run(sys.argv[1:])
    except Exception:
        return 125  # Closed failure code; no command/output/environment logging.
    return 73  # Runtime also requires private ECHILD witness + cgroup empty.



if __name__ == "__main__":
    raise SystemExit(main())
