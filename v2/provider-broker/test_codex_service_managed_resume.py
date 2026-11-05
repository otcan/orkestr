"""Synthetic private bootstrap transport checks; no Core grants or live native."""
import array
import os
import socket
import time
import unittest
from unittest.mock import patch

from codex_bounded.trust import process
from codex_service.contract import Refused, encode
from codex_service.channel import receive_control
from codex_service import managed_resume
from test_codex_service_launch import request


class ManagedResumeTests(unittest.TestCase):
    def read(self, payload, *, native='synthetic-resume', source=None):
        a, b = socket.socketpair()
        context = {'server_' + key: value for key, value in (source or process(os.getpid())).items()
                   if key in ('pid', 'uid', 'start')}
        context['setup'] = dict(role='deep', provider='codex', native_session_id=native)
        try:
            a.sendall(payload); a.shutdown(socket.SHUT_WR)
            with patch.object(managed_resume, 'launch_context', return_value=context):
                return managed_resume.receive(descriptor=b.detach())
        finally:
            a.close(); b.close()

    def test_exact_original_bootstrap_not_stdio_or_another_native(self):
        self.assertEqual(self.read(b'codex-resume-v1\0synthetic-resume'), 'synthetic-resume')
        for bad in (b'{"native":"synthetic-resume"}', b'codex-resume-v1\0another-native',
                    b'claude-resume-v1\0synthetic-resume', b'x' * 600):
            with self.subTest(payload=bad[:30]), self.assertRaises(Refused):
                self.read(bad)
        source = process(os.getpid()); source['uid'] += 1
        with self.assertRaisesRegex(Refused, 'managed_resume_peer'):
            self.read(b'codex-resume-v1\0synthetic-resume', source=source)
        source = process(os.getpid()); source['start'] += 1
        with self.assertRaisesRegex(Refused, 'source_changed'):
            self.read(b'codex-resume-v1\0synthetic-resume', source=source)

    def test_resume_requires_five_descriptors_and_matching_typed_setup(self):
        for count, mode, native, succeeds in [(5, 'resume', True, True),
                (4, 'resume', True, False), (5, 'fresh', False, False),
                (5, 'resume', False, False), (4, 'fresh', True, False)]:
            with self.subTest(count=count, mode=mode, native=native):
                a, b = socket.socketpair(); read, write = os.pipe(); descriptors = []
                try:
                    value = request(); value['mode'] = mode
                    if native:
                        value['setup']['native_session_id'] = 'synthetic-resume'
                        value['setup']['resume_setup_id'] = '22222222-2222-4222-8222-222222222222'
                    a.sendmsg([encode(value)], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                               array.array('i', [read] * count))])
                    a.shutdown(socket.SHUT_WR)
                    if succeeds:
                        _, descriptors = receive_control(b, time.monotonic() + 1)
                        self.assertEqual(len(descriptors), 5)
                    else:
                        with self.assertRaises(Refused): receive_control(b, time.monotonic() + 1)
                finally:
                    for fd in descriptors: os.close(fd)
                    os.close(read); os.close(write); a.close(); b.close()
