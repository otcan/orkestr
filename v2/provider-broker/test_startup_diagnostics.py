"""Synthetic local children only. Never provider credentials or live sessions."""
import json
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from protocol import Failure, MAX_FRAME, Refused
from startup_diagnostics import CAPTURE_BYTES, MAX_OBSERVED, StderrCapture, report_failure
from transport import Pump, reap_uncontained


class CaptureTests(unittest.TestCase):
    def test_only_fixed_labels_escape_even_with_secrets_urls_and_controls(self):
        capture = StderrCapture()
        secret = b'SYNTHETIC_SECRET_VALUE'
        capture.feed(b'authentication failed: ' + secret + b' https://private.invalid/a\x1b[31m\n')
        capture.feed(b'connection re')
        capture.feed(b'set\xff\xfe\n')
        value = capture.summary()
        self.assertEqual(value['classes'], ['authentication', 'network'])
        rendered = json.dumps(value)
        for forbidden in ('SYNTHETIC_SECRET_VALUE', 'private.invalid', 'failed', '\\u001b'):
            self.assertNotIn(forbidden, rendered)
        self.assertTrue(value['free_text_redacted'])
        self.assertEqual(set(value), {'classes', 'observed_bytes', 'retained_bytes',
                                     'truncated', 'free_text_redacted'})

    def test_tail_memory_and_observation_counter_are_bounded(self):
        capture = StderrCapture()
        capture.feed(b'permission denied' + b'x' * (CAPTURE_BYTES * 3))
        capture.feed(b' unknown option')
        self.assertEqual(len(capture.tail), CAPTURE_BYTES)
        self.assertEqual(capture.summary()['classes'], ['argument'])
        self.assertTrue(capture.summary()['truncated'])
        capture.observed = MAX_OBSERVED - 1
        capture.feed(b'xx')
        self.assertEqual(capture.summary()['observed_bytes'], MAX_OBSERVED)

    def test_empty_unknown_and_partial_utf8_are_value_free(self):
        capture = StderrCapture()
        self.assertEqual(capture.summary()['classes'], [])
        capture.feed(b'\xff\xc3')
        self.assertEqual(capture.summary()['classes'], ['unclassified'])

    def test_report_is_closed_and_logger_failure_has_no_lifecycle_effect(self):
        capture = StderrCapture()
        capture.feed(b'invalid token SYNTHETIC_SECRET_VALUE')
        pump = SimpleNamespace(failure_exit=80 + (int(Failure.PROVIDER_EOF) - 1) * 6 + 3,
            channel=SimpleNamespace(initialized=False, setup=(1, 2)), stderr_capture=capture,
            last_provider_frame_bytes=123, reaped=False)
        messages = []
        report_failure(pump, True, messages.append)
        value = json.loads(messages[0])
        self.assertEqual(value['phase'], 'initializing')
        self.assertEqual(value['native_state'], 3)
        self.assertEqual(value['last_provider_frame_bytes'], 123)
        self.assertEqual(value['failure_class'], int(Failure.PROVIDER_EOF))
        self.assertTrue(value['resumed'])
        self.assertTrue(value['diagnostic_only'])
        before = vars(pump).copy()
        def broken(_message):
            raise OSError('synthetic logger unavailable')
        report_failure(pump, True, broken)
        self.assertEqual(vars(pump), before)
        for code in (None, 0, 2, 73, 79, 218, True, '80'):
            pump.failure_exit = code
            report_failure(pump, False, messages.append)
        self.assertEqual(len(messages), 1)


class PumpCaptureTests(unittest.TestCase):
    def pump(self, script, capture=True):
        incoming, writer = os.pipe()
        reader, outgoing = os.pipe()
        descriptors = {incoming, writer, reader, outgoing}
        def close(fd):
            if fd in descriptors:
                descriptors.remove(fd)
                os.close(fd)
        self.addCleanup(lambda: [close(fd) for fd in list(descriptors)])
        received = []
        class Channel:
            initialized = False
            setup = (1, 2)
            def client(self, _value):
                return None, None
            def provider(self, value):
                received.append(value)
                close(writer)
                return None
        config = SimpleNamespace(uncontained=True, workspace='/',
            command=lambda: [sys.executable, '-I', '-S', '-B', '-c',
                'import os,signal,sys,time\nsignal.alarm(4)\n' + script],
            environment=lambda: {'PYTHONDONTWRITEBYTECODE': '1'})
        pump = Pump(config, Channel(), incoming, outgoing, diagnostics=True,
                    stderr_capture=StderrCapture() if capture else None)
        os.write(writer, b'{}\n')
        return pump, received

    def test_stderr_flood_does_not_block_or_enter_provider_protocol(self):
        size = CAPTURE_BYTES * 24
        pump, received = self.pump(
            f'os.write(2, b"x" * {size})\n'
            'os.write(2,b" network connection failed SYNTHETIC_SECRET_VALUE")\n'
            'os.close(2)\nprint("{\\"ready\\":true}",flush=True)\nsys.stdin.read()\n')
        pump.run()
        self.assertEqual(received, [{'ready': True}])
        self.assertTrue(pump.parent_eof)
        self.assertTrue(pump.reaped)
        self.assertIsNotNone(pump.child.returncode)
        value = pump.stderr_capture.summary()
        self.assertGreater(value['observed_bytes'], size)
        self.assertEqual(value['retained_bytes'], CAPTURE_BYTES)
        self.assertEqual(value['classes'], ['network'])
        self.assertTrue(pump.child.stderr.closed)

    def test_stderr_eof_does_not_end_provider_or_create_readiness(self):
        pump, received = self.pump('os.close(2)\ntime.sleep(.04)\n'
            'print("{\\"ready\\":true}",flush=True)\nsys.stdin.read()\n')
        pump.run()
        self.assertEqual(received, [{'ready': True}])
        self.assertTrue(pump.reaped)
        self.assertEqual(pump.stderr_capture.summary()['observed_bytes'], 0)

    def test_default_stderr_remains_devnull(self):
        pump, received = self.pump('os.write(2,b"not json\\n")\n'
            'print("{\\"ready\\":true}",flush=True)\nsys.stdin.read()\n', capture=False)
        pump.run()
        self.assertIsNone(pump.child.stderr)
        self.assertEqual(received, [{'ready': True}])

    def test_invalid_provider_frame_reports_size_and_reaps_before_diagnostic(self):
        pump, _ = self.pump('os.write(2,b"authentication failed SYNTHETIC_SECRET_VALUE")\n'
                            'os.write(1,b"bad json\\n")\nsys.stdin.read()\n')
        with self.assertRaises(Refused):
            pump.run()
        self.assertEqual(pump.last_provider_frame_bytes, len(b'bad json'))
        self.assertTrue(pump.reaped)
        messages = []
        report_failure(pump, False, messages.append)
        self.assertEqual(json.loads(messages[0])['stderr']['classes'], ['authentication'])
        self.assertNotIn('SYNTHETIC_SECRET_VALUE', messages[0])

    def test_cleanup_exception_still_closes_diagnostic_pipe_and_selector(self):
        pump, _ = self.pump('os.write(1,b"bad json\\n")\nsys.stdin.read()\n')
        def broken_cleanup(child):
            reap_uncontained(child)
            raise RuntimeError('synthetic cleanup failure')
        with patch('transport.reap_uncontained', side_effect=broken_cleanup):
            with self.assertRaisesRegex(RuntimeError, 'synthetic cleanup failure'):
                pump.run()
        self.assertTrue(pump.child.stderr.closed)
        self.assertIsNone(pump.selector.get_map())

    def test_bound_refusal_preserves_size_without_retaining_provider_text(self):
        pump = Pump(None, None, incoming=100, outgoing=101, diagnostics=True)
        self.addCleanup(pump.selector.close)
        pump.buffers[102] = b'x' * (MAX_FRAME + 1)
        with self.assertRaises(Refused):
            pump.drain_buffer(102)
        self.assertEqual(pump.last_provider_frame_bytes, MAX_FRAME + 1)

    def test_truncated_provider_frame_preserves_size(self):
        pump, _ = self.pump('os.write(1,b"incomplete")\n')
        with self.assertRaises(Refused):
            pump.run()
        self.assertEqual(pump.last_provider_frame_bytes, len(b'incomplete'))
        self.assertTrue(pump.reaped)
