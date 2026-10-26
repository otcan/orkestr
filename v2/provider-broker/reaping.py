"""Linux owned-native cleanup proof; no PID or wire assertion is accepted."""
import ctypes
import errno
import os
import signal
import time

REAPED_EXIT = 73
# 218..223: the native ended on its own (EOF), and this broker, as subreaper,
# then reaped its whole owned tree to ECHILD. +0..5 keeps the diagnostic
# native state of the PROVIDER_EOF failure class. Runtime accepts it as
# cleanup proof only for an idle accepted Fast native, never as a delivery.
NATIVE_ENDED_REAPED = 218


def native_ended_exit(pump, code):
    """The native-ended-and-reaped exit for a PROVIDER_EOF failure class."""
    from protocol import Failure
    base = 80 + (int(Failure.PROVIDER_EOF) - 1) * 6
    if (type(code) is int and base <= code < base + 6 and pump is not None
            and pump.reaped is True and pump.parent_eof is False and pump.child is not None):
        return NATIVE_ENDED_REAPED + code - base
    return code


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
