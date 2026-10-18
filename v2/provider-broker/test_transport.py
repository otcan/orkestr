import unittest
from unittest.mock import patch
from protocol import Channel, Refused
from transport import MAX_PENDING, Pump


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.pump = Pump(None, Channel("/synthetic/workspace"), incoming=100, outgoing=101)

    def tearDown(self):
        self.pump.selector.close()

    def test_output_queue_is_bounded(self):
        for _ in range(MAX_PENDING):
            self.pump.queue(101, {"synthetic": True})
        with self.assertRaises(Refused):
            self.pump.queue(101, {})
        self.assertEqual(len(self.pump.queues[101]), MAX_PENDING)

    def test_partial_write_keeps_suffix_and_wouldblock_never_replays(self):
        self.pump.queue(101, {"synthetic": True})
        original = self.pump.queues[101][0]
        with patch("transport.os.write", return_value=3) as write:
            self.pump.write(101)
            write.assert_called_once_with(101, original)
        self.assertEqual(self.pump.queues[101][0], original[3:])
        with patch("transport.os.write", side_effect=BlockingIOError):
            self.pump.write(101)
        self.assertEqual(self.pump.queues[101][0], original[3:])
        with patch("transport.os.write", side_effect=BrokenPipeError):
            with self.assertRaises(BrokenPipeError):
                self.pump.write(101)  # fatal to run/main; no recovery or reissue

    def test_unbounded_partial_input_and_truncated_eof_refused(self):
        with patch("transport.os.read", return_value=b"x" * 65536):
            self.pump.read(100)
        with patch("transport.os.read", return_value=b"x"):
            with self.assertRaises(Refused):
                self.pump.read(100)
        with patch("transport.os.read", return_value=b""):
            with self.assertRaises(Refused):
                self.pump.read(100)

    def test_arbitrary_command_cannot_launch_provider(self):
        with self.assertRaises(Refused):
            self.pump.line(100, b'{"id":1,"method":"exec","params":{"argv":["forbidden"]}}')
        self.assertIsNone(self.pump.child)
