"""Authenticate a mounted inner supervisor before counting or parsing a channel."""
from pathlib import Path
import socket
import struct
from .configuration import HELPERS, HOSTS
from .trust import Refused, belongs, exists, process, protected, require


def authenticate(connection, package, owner):
    pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    identity = process(pid)
    if uid != package.uid or not identity or not owner or not belongs(pid, owner):
        return None
    try:
        arguments = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[:-1]
        require(len(arguments) == 7 and arguments[:4] ==
                [b"/usr/bin/python3", b"-I", b"-B", b"/opt/provider/supervisor.py"] and
                arguments[4].isdigit() and 2 < int(arguments[4]) < 65536 and
                arguments[5:] == [",".join(HOSTS).encode(), b"codex-bounded"], "inner_arguments")
        require(Path(f"/proc/{pid}/exe").resolve() == Path("/usr/bin/python3").resolve(), "inner_interpreter")
        for name in ("supervisor.py", "authenticated_budget.py", *HELPERS):
            expected = protected(package.root / "isolation" / name).stat()
            actual = Path(f"/proc/{pid}/root/opt/provider/{name}").stat()
            require((expected.st_dev, expected.st_ino) == (actual.st_dev, actual.st_ino), "inner_mounted_source")
        require(exists(identity) and belongs(pid, owner), "inner_owner_changed")
        return identity
    except (OSError, ValueError, Refused):
        return None
