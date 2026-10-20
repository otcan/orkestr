"""Fixed command-only subreaper. No provider credentials, protocol or authority.

Runtime owns this original Child outside the job cgroup. Only bwrap and its
descendants enter that cgroup; after cgroup.kill this process retains waitpid
ownership through ECHILD, including setsid/double-fork descendants.

Layout mode (ORKESTR_SUPERVISOR_LAYOUT_V1) is used only by the operator-
configured trusted profile: Runtime computes the exact bwrap argv/environment
and passes it through a sealed descriptor, so credential values never appear in
any process argv. The isolation flags below remain mandatory in that mode.
"""
import ctypes
import json
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


REQUIRED = ("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
            "--unshare-cgroup", "--disable-userns", "--assert-userns-disabled",
            "--die-with-parent", "--new-session")


def host(value, workspace):
    """ORKESTR_SUPERVISOR_HOST_V1: operator host-privileged mode. No bwrap,
    namespace, seccomp or no_new_privs; equivalent to host root when the
    service user has sudo. Job cgroup, timeout, kill and reap still apply."""
    env, passed = value["env"], value["pass"]
    if (type(env) is not dict or not all(type(k) is str and type(v) is str
            and "\0" not in k + v and "=" not in k and k for k, v in env.items())
            or not {"HOME", "PATH", "PWD"} <= set(env) or passed != [workspace]):
        raise ValueError("closed host layout required")
    return None, env, (workspace,)


def layout(fd, policy, workspace, image):
    with os.fdopen(fd, "rb", closefd=True) as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("layout bound")
    value = json.loads(raw.decode())
    if type(value) is dict and set(value) == {"host", "env", "pass"} and value["host"] is True:
        return host(value, workspace)
    if type(value) is not dict or set(value) != {"argv", "env", "pass"}:
        raise ValueError("closed layout required")
    argv, env, passed = value["argv"], value["env"], value["pass"]
    def pair(first, second):
        return any(argv[i:i + 2] == [first, second] for i in range(len(argv)))
    if (type(argv) is not list or not all(type(a) is str and "\0" not in a for a in argv)
            or not argv or argv[0] != "/usr/bin/bwrap" or "--" in argv
            or any(flag not in argv for flag in REQUIRED)
            or not pair("--seccomp", str(policy)) or not pair("--cap-drop", "ALL")):
        raise ValueError("isolating layout required")
    if (type(env) is not dict or not all(type(k) is str and type(v) is str
            and "\0" not in k + v and "=" not in k for k, v in env.items())
            or any(k.startswith(("LD_", "PYTHON")) for k in env)):
        raise ValueError("closed environment required")
    if (type(passed) is not list or not set(passed) <= {policy, workspace, image}
            or not {policy, workspace} <= set(passed)):
        raise ValueError("closed descriptor set required")
    return argv, env, tuple(passed)


def run(argv):
    trusted = len(argv) == 8 and argv[6] == "--"
    if not trusted and (len(argv) != 7 or argv[5] != "--"):
        raise ValueError("fixed command operation required")
    count = 6 if trusted else 5
    fds = tuple(int(value) for value in argv[:count])
    if len(set(fds)) != count or any(fd < 3 for fd in fds):
        raise ValueError("distinct retained descriptors required")
    policy, image, workspace, cgroup, ready = fds[:5]
    os.set_inheritable(ready, False)
    command = argv[count + 1]
    directory = None
    if trusted:
        launch, environment, passed = layout(fds[5], policy, workspace, image)
        if launch is None:
            # Host mode: the project descriptor is only the initial cwd.
            launch, directory, passed = ["/bin/sh", "-c", command], workspace, ()
        else:
            launch = [*launch, "--", "/bin/sh", "-c", command]
    else:
        launch = arguments(policy, image, workspace, command)
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        passed = fds[:3]
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
        if directory is not None:
            os.fchdir(directory)
            os.setsid()

    child = None
    status = None
    try:
        child = subprocess.Popen(
            launch,
            stdin=subprocess.DEVNULL, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer,
            close_fds=True, pass_fds=(*passed, cgroup), preexec_fn=attach,
            env=environment,
        )
        environment = None
        os.write(ready, b"R")  # cgroup attach completed before Popen returned.
        for fd in (policy, image, workspace, cgroup):
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


# ORKESTR_SUPERVISOR_LAYOUT_V1
# ORKESTR_SUPERVISOR_HOST_V1
def main():
    try:
        status = run(sys.argv[1:])
    except Exception:
        return 125  # Closed failure code; no command/output/environment logging.
    return 73  # Runtime also requires private ECHILD witness + cgroup empty.



if __name__ == "__main__":
    raise SystemExit(main())
