"""Actual synthetic native pipe oracle; durable Store races belong to Runtime.

No provider executable, account or host configuration is used. Runtime can use
READER as its native peer and the resulting bytes as the actual-I/O oracle.
"""
import array
import os
from pathlib import Path
import socket
import tempfile
import unittest

from protocol import Channel
from transport import Pump

READER = '''#!/usr/bin/python3
import os, sys
with open(sys.argv[1], "wb", buffering=0) as output:
 while True:
  chunk = os.read(0, 4096)
  if not chunk: break
  output.write(chunk)
'''


class NativeWriterTests(unittest.TestCase):
    def exercise(self, prefix):
        with tempfile.TemporaryDirectory(prefix="broker-native-writer-") as temporary:
            root = Path(temporary)
            executable, observed = root / "native", root / "observed"
            executable.write_text(READER)
            executable.chmod(0o700)
            class Config:
                workspace = root
                def command(self):
                    return [str(executable), str(observed)]
                def environment(self):
                    return {"PATH": "/usr/bin:/bin"}
            parent, broker = socket.socketpair()
            parent.settimeout(5)
            pump = Pump(Config(), Channel(str(root)), incoming=100, outgoing=101,
                        handoff=broker)
            writer = None
            try:
                pump.launch()
                raw, ancillary, flags, _ = parent.recvmsg(64, socket.CMSG_SPACE(4),
                                                         socket.MSG_CMSG_CLOEXEC)
                self.assertEqual(raw, b"provider-stdin-v1")
                self.assertEqual(len(ancillary), 1)
                level, kind, payload = ancillary[0]
                self.assertEqual((level, kind), (socket.SOL_SOCKET, socket.SCM_RIGHTS))
                descriptors = array.array("i")
                descriptors.frombytes(payload)
                self.assertEqual(len(descriptors), 1)
                writer = descriptors[0]
                self.assertFalse(os.get_inheritable(writer))
                self.assertFalse(os.get_blocking(writer))
                self.assertIsNone(pump.child.stdin)
                self.assertEqual(set(pump.queues), {101})
                self.assertEqual(parent.recv(1), b"")
                # Model the Runtime decision AFTER preparation. A revoked staged
                # frame is discarded; partial effects remain unknown, not retryable.
                if prefix:
                    self.assertEqual(os.write(writer, prefix), len(prefix))
                os.close(writer)
                writer = None
                # EOF without killing proves broker retained no stdin duplicate.
                self.assertEqual(pump.child.wait(timeout=5), 0)
                self.assertEqual(observed.read_bytes(), prefix)
            finally:
                if writer is not None:
                    os.close(writer)
                parent.close()
                broker.close()
                pump.selector.close()
                if pump.child is not None:
                    if pump.child.poll() is None:
                        pump.child.kill()
                    pump.child.wait(timeout=5)
                    pump.child.stdout.close()

    def test_revoked_buffered_frame_delivers_zero_bytes(self):
        self.exercise(b"")

    def test_partial_prefix_is_not_completed_or_replayed(self):
        self.exercise(b'{"id":1,"method":"turn/')


if __name__ == "__main__":
    unittest.main()
