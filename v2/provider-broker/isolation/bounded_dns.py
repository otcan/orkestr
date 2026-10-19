"""Cancellable DNS in a fixed owned child; no unjoinable resolver threads."""
import ctypes
import ipaddress
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import time

if __package__:
    from .bounded_budget import Refused, CleanupIncomplete
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bounded_budget import Refused, CleanupIncomplete


MAX_RESPONSE = 8192


def validated(records):
    if not isinstance(records, list) or not 0 < len(records) <= 16:
        raise Refused("dns_answers")
    result = []
    for record in records:
        if not isinstance(record, list) or len(record) != 5:
            raise Refused("dns_shape")
        family, kind, protocol, name, address = record
        if (type(family) is not int or type(kind) is not int or type(protocol) is not int
                or name != "" or not isinstance(address, list)
                or family not in (socket.AF_INET, socket.AF_INET6)
                or kind != socket.SOCK_STREAM or protocol not in (0, socket.IPPROTO_TCP)
                or len(address) != (2 if family == socket.AF_INET else 4)
                or type(address[0]) is not str or type(address[1]) is not int or address[1] != 443
                or any(type(value) is not int or value < 0 or value > 2**32-1 for value in address[2:])):
            raise Refused("dns_shape")
        ip = ipaddress.ip_address(address[0])
        if not ip.is_global or ip.version != (4 if family == socket.AF_INET else 6):
            raise Refused("dns_public")
        result.append((family, kind, protocol, tuple(address)))
    return result


def resolve(context, host, helper=None, observer=None):
    """host comes only from the unchanged exact-host CONNECT normalizer.

    Optional helper/observer are trusted test seams, never request/profile input.
    No inherited account environment or descriptors cross this boundary.
    """
    context.check()
    executable = str(Path(__file__).resolve()) if helper is None else str(helper)
    child = subprocess.Popen([sys.executable, "-I", "-B", executable,
        "--resolve", str(os.getpid()), host], env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        close_fds=True, start_new_session=True)
    output = bytearray()
    try:
        if observer is not None:
            observer(child)
        os.set_blocking(child.stdout.fileno(), False)
        while True:
            context.check()
            ready, _, _ = select.select([child.stdout], [], [], .01)
            if not ready:
                continue
            chunk = os.read(child.stdout.fileno(), min(4096, MAX_RESPONSE + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_RESPONSE:
                raise Refused("dns_bound")
        context.check()
        remaining = min(1.0, max(0, context.deadline - time.monotonic()))
        if child.wait(timeout=remaining) != 0:
            raise Refused("dns_failed")
        return validated(json.loads(output))
    except (ValueError, UnicodeError, subprocess.TimeoutExpired):
        raise Refused("dns_failed") from None
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill()
        # Cleanup is bounded separately from the setup authority cutoff. A
        # failure to reap is surfaced to the owner; never silently detach.
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            raise CleanupIncomplete("resolver_reap_failed") from None


def child_main():
    if len(sys.argv) != 4 or sys.argv[1] != "--resolve":
        return 2
    parent = int(sys.argv[2])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        return 2
    host = sys.argv[3]
    if not 0 < len(host) <= 253 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in host):
        return 2
    records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    # Canonical names are not part of the numeric response. Reject every
    # nonpublic/malformed answer before returning any usable address.
    payload = [[int(f), int(k), int(p), "", list(a)] for f, k, p, _n, a in records]
    validated(payload)
    encoded = json.dumps(payload, separators=(",", ":")).encode()
    if len(encoded) > MAX_RESPONSE:
        return 2
    sys.stdout.buffer.write(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(child_main())
    except Exception:
        raise SystemExit(2)
