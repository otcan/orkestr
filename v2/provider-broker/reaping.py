"""Linux owned-native cleanup proof; no PID or wire assertion is accepted."""
import ctypes
import errno
import os
import signal
import time

REAPED_EXIT = 73


def contained_command(command):
    # Trusted connector lifetime containment only. This preserves the existing
    # filesystem/network view; authenticated filesystem/egress is a separate profile.
    from pathlib import Path
    import stat
    launcher=Path("/usr/bin/bwrap")
    for item in (launcher,*launcher.parents):
        info=item.stat()
        if info.st_uid!=0 or info.st_mode & 0o022:
            raise ValueError("untrusted lifetime launcher")
    if not stat.S_ISREG(launcher.stat().st_mode):
        raise ValueError("invalid lifetime launcher")
    # bwrap establishes parent-death handling during startup; namespace init
    # death kills every namespace descendant, including setsid/double-fork.
    # No preexec_fn or interpreter-before-prctl race is introduced.
    return [str(launcher),"--unshare-user","--unshare-pid","--die-with-parent",
            "--bind","/","/","--proc","/proc","--"]+list(command)


def become_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "subreaper refused")


def reap_owned(child, timeout=2.0):
    # Do not poll/wait the direct child first: its unreaped PID pins the owned
    # process-group identity even if it exited before this cleanup operation.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + timeout
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        except OSError as error:
            if error.errno == errno.ECHILD:
                return True
            raise
        if pid == child.pid:
            child.returncode = os.waitstatus_to_exitcode(status)
        if pid == 0:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
