"""Fixed Linux x86-64 runtime mounts and sealed syscall policy."""
import fcntl
import os
from pathlib import Path
import platform
import stat
import struct


def trusted(path, directory=False):
    source = Path(path)
    canonical = source.resolve(strict=True)
    for item in (source, *source.parents, canonical, *canonical.parents):
        info = item.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("untrusted isolation runtime")
    info = canonical.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else
            stat.S_ISREG(info.st_mode) and info.st_mode & 0o111):
        raise ValueError("invalid isolation runtime")
    return str(canonical)


def filter_fd(allow_inet=False):
    if platform.machine() != "x86_64":
        raise ValueError("unsupported provider sandbox architecture")
    # Kill wrong ABI/x32; deny sockets, fork/process escape and cross-process IO.
    program = [(0x20,0,0,4),(0x15,1,0,0xc000003e),(0x06,0,0,0x80000000),
               (0x20,0,0,0),(0x35,0,1,0x40000000),(0x06,0,0,0x80000000)]
    for syscall in ((() if allow_inet else (41,)) + (53,57,58,101,165,166,155,161,272,308,310,311,438,
                    425,426,427,248,249,250,298,321,323,169,175,176,246,313,
                    320,303,304,428,429,430,431,432,433,442)):
        program.extend(((0x15,0,1,syscall),(0x06,0,0,0x00050001)))
    if allow_inet:
        # Only AF_INET stream sockets inside the private network namespace.
        # AF_UNIX would expose the supervisor-only egress endpoint directly.
        program.extend(((0x15,0,7,41),(0x20,0,0,16),(0x15,0,3,2),
                        (0x20,0,0,24),(0x54,0,0,15),(0x15,1,0,1),
                        (0x06,0,0,0x00050001),(0x06,0,0,0x7fff0000)))
    # Native runtimes may create threads, never independent processes. Force
    # clone3 ENOSYS so libc can fall back to inspected classic clone flags.
    program.extend(((0x15,0,1,435),(0x06,0,0,0x00050026)))
    program.extend(((0x15,0,5,56),(0x20,0,0,16),(0x54,0,0,0x10900),
                    (0x15,0,1,0x10900),(0x06,0,0,0x7fff0000),
                    (0x06,0,0,0x00050001)))
    program.append((0x06,0,0,0x7fff0000))
    fd = os.memfd_create("provider-isolation-policy",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
    try:
        os.write(fd,b"".join(struct.pack("HBBI",*instruction) for instruction in program))
        os.lseek(fd,0,os.SEEK_SET)
        fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|
                    fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
        return fd
    except BaseException:
        os.close(fd)
        raise


def command(executable, arguments, policy):
    python = trusted("/usr/bin/python3")
    library = str(Path("/usr/lib") / Path(python).name)
    trusted(library,True)
    trusted("/usr/lib/x86_64-linux-gnu",True)
    loader = trusted("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2")
    argv = [trusted("/usr/bin/bwrap"),"--unshare-user","--unshare-pid","--unshare-net",
            "--unshare-ipc","--unshare-uts","--unshare-cgroup","--disable-userns",
            "--assert-userns-disabled","--die-with-parent","--new-session",
            "--cap-drop","ALL","--clearenv",
            "--ro-bind",python,"/usr/bin/python3",
            "--ro-bind",library,library,
            "--ro-bind","/usr/lib/x86_64-linux-gnu","/usr/lib/x86_64-linux-gnu",
            "--symlink","usr/lib","/lib","--ro-bind",loader,"/lib64/ld-linux-x86-64.so.2"]
    if executable != python:
        argv += ["--ro-bind",trusted(executable),"/opt/provider/native"]
    argv += ["--proc","/proc","--remount-ro","/proc","--dev","/dev",
             "--size","8388608","--tmpfs","/dev/shm","--remount-ro","/dev"]
    for path in ("/tmp","/home/provider","/account","/work"):
        argv += ["--size","16777216","--tmpfs",path]
    argv += ["--chdir","/work","--remount-ro","/",
             "--setenv","HOME","/home/provider","--setenv","TMPDIR","/tmp",
             "--setenv","PATH","/usr/bin","--setenv","LANG","C.UTF-8",
             "--setenv","CODEX_HOME","/account","--setenv","CLAUDE_CONFIG_DIR","/account",
             "--seccomp",str(policy),"--",
             "/usr/bin/python3" if executable == python else "/opt/provider/native"]
    # Exec in-place through a fixed root-owned limiter; no Python preexec hook
    # in a potentially multithreaded broker. Limits affect this child only.
    return [trusted("/usr/bin/prlimit"),"--cpu=3:3","--as=1073741824:1073741824",
            "--fsize=8388608:8388608","--core=0:0","--nofile=64:64","--"] + argv + list(arguments)
