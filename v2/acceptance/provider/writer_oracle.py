#!/usr/bin/env python3
"""Independent actual-pipe oracle; synthetic peer, no Store or provider account."""
import argparse
import array
import json
import os
from pathlib import Path
import socket
import sys
import tempfile


def exercise(broker_root, prefix):
    # Explicit source archive, never the installed private broker package.
    sys.path.insert(0, str(broker_root))
    from protocol import encode
    from transport import Pump
    from test_protocol import opened, ready, turn
    with tempfile.TemporaryDirectory(prefix="v2-independent-writer-") as temporary:
        root = Path(temporary)
        observed = root / "observed"
        # Read bytes, not lines: an incomplete prefix must be visible to this
        # oracle even when it cannot yet be parsed by a provider JSON decoder.
        reader = """import os,sys
with open(sys.argv[1], 'wb', buffering=0) as out:
 while True:
  chunk=os.read(0,4096)
  if not chunk: break
  out.write(chunk)
"""
        class Fixture:
            workspace = root
            def command(self):
                return ["/usr/bin/python3", "-I", "-B", "-c", reader, str(observed)]
            def environment(self):
                return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        # Reuse only authored protocol fixture input; the process/byte oracle
        # and the assertions below are independently implemented.
        channel, handle = opened()
        ready(channel)
        parent, inherited = socket.socketpair()
        parent.settimeout(5)
        pump = Pump(Fixture(), channel, incoming=100, outgoing=101, handoff=inherited)
        received_fds = []
        try:
            pump.launch()
            marker, rights, flags, _ = parent.recvmsg(64, socket.CMSG_SPACE(16), socket.MSG_CMSG_CLOEXEC)
            for level, kind, payload in rights:
                assert (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS)
                descriptors = array.array("i")
                descriptors.frombytes(payload)
                received_fds.extend(descriptors)
            assert flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) == 0
            assert marker == b"provider-stdin-v1" and len(received_fds) == 1
            writer = received_fds[0]
            assert not os.get_inheritable(writer) and not os.get_blocking(writer)
            assert pump.child.stdin is None and set(pump.queues) == {101}
            assert parent.recv(1) == b""
            # A validated CommitExecution is prepared while the real peer waits
            # on its stdin. The broker must never buffer a native write of it.
            frame = {"id": 6, "method": "CommitExecution", "params": {
                "owned_handle": handle, "frame": turn()}}
            pump.line(100, encode(frame).rstrip(b"\n"))
            assert len(pump.queues[101]) == 1
            assert json.loads(pump.queues[101][0]) == {"method": "BrokerPrepared", "params": {
                "owned_handle": handle, "request_id": 6}}
            assert set(pump.queues) == {101}
            if prefix:
                assert os.write(writer, prefix) == len(prefix)
            os.close(received_fds.pop())
            # An EOF exit without terminating the peer proves no broker writer
            # duplicate survives. Exact bytes prove no buffered suffix/replay.
            assert pump.child.wait(timeout=5) == 0
            assert observed.read_bytes() == prefix
            return {"native_bytes": len(prefix), "broker_native_queues": 0,
                    "peer_exited_on_eof": True, "partial_suffix_replayed": False}
        finally:
            for fd in received_fds:
                os.close(fd)
            parent.close()
            inherited.close()
            pump.selector.close()
            if pump.child is not None:
                if pump.child.poll() is None:
                    pump.child.kill()
                pump.child.wait(timeout=5)
                pump.child.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--broker-root", type=Path, required=True)
    args = parser.parse_args()
    try:
        outcomes = [exercise(args.broker_root.resolve(strict=True), b""),
                    exercise(args.broker_root.resolve(strict=True), b'{"id":4,"method":"turn/')]
        receipt = {"status": "passed", "cases": outcomes, "real_provider_started": False,
                   "scope": "sole_writer_byte_oracle_not_durable_revocation_race"}
    except Exception:
        receipt = {"status": "failed", "code": "writer_oracle_failed"}
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
