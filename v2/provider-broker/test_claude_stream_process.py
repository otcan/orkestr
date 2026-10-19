"""Actual owned synthetic child/FD3/ClaudePump path; no Core or provider claim."""
import array
import json
import os
from pathlib import Path
import select
import socket
import tempfile
import time
import unittest

from claude_connector import ClaudeConfiguration
from claude_protocol import ClaudeChannel
from claude_pump import ClaudePump
from protocol import PROTOCOL, encode
from reaping import reap_owned
from test_protocol import IDENTITY


class ClaudeStreamProcessTests(unittest.TestCase):
    def run_child(self, mode):
        with tempfile.TemporaryDirectory(prefix='claude-partial-owned-') as directory:
            root = Path(directory).resolve(); executable = root / 'synthetic-native'
            executable.write_bytes(Path(__file__).with_name('claude_stream_native_fixture.py').read_bytes())
            executable.chmod(0o700)
            session = ClaudeConfiguration(executable, root, root, root, root).new_session()
            channel = ClaudeChannel(session)
            channel.client({'id': 1, 'method': 'OpenOwnedSession', 'params': {
                'protocol': PROTOCOL, 'identity': dict(IDENTITY, provider='claude')}})
            parent, handoff = socket.socketpair(); parent.settimeout(5)
            pump = ClaudePump(session, channel, incoming=100, outgoing=101, handoff=handoff)
            writer = None
            try:
                pump.launch()
                _, rights, _, _ = parent.recvmsg(64, socket.CMSG_SPACE(4))
                descriptors = array.array('i'); descriptors.frombytes(rights[0][2]); writer = descriptors[0]
                self.assertEqual(len(descriptors), 1)
                pid = pump.child.pid
                start = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]

                def observe():
                    deadline = time.monotonic() + 5
                    while not pump.queues[101]:
                        self.assertLess(time.monotonic(), deadline, 'owned synthetic output timed out')
                        ready, _, _ = select.select([pump.child.stdout], [], [], .05)
                        if ready: pump.read(pump.child.stdout.fileno())
                    return json.loads(pump.queues[101].popleft())

                setup = {'type': 'control_request', 'request_id': 'setup:synthetic',
                         'request': {'subtype': 'initialize', 'hooks': None}}
                channel.client({'id': 2, 'method': 'BrokerMetadata', 'params': {
                    'owned_handle': channel.handle, 'frame': setup}})
                os.write(writer, encode(setup)); self.assertEqual(observe()['params']['request_id'], 2)
                current = '33333333-3333-4333-8333-333333333333'
                submitted = {'type': 'user', 'session_id': str(session.native), 'uuid': current,
                             'parent_tool_use_id': None, 'message': {'role': 'user', 'content': mode}}
                channel.client({'id': 3, 'method': 'CommitExecution', 'params': {
                    'owned_handle': channel.handle, 'message_id': 'synthetic-message', 'frame': submitted}})
                os.write(writer, encode(submitted))
                self.assertEqual(observe()['params']['frame']['subtype'], 'init')
                self.assertEqual(len(channel.telemetry_uuids), 1)
                first = observe()['params']['frame']
                piece = 'synthetic chunk ' * 400
                self.assertEqual(first['message']['content'], [{'type': 'text', 'text': piece}])
                self.assertEqual(channel.stream.full, 1)  # The discard-only thinking block.
                self.assertFalse(channel.stream.blocks[1]['verified'])
                self.assertNotIn('SYNTHETIC_DISCARDED_THINKING', repr(channel.stream.__dict__))
                self.assertFalse(channel.terminal or (root / 'release-synthetic-stream').exists())
                if mode == 'cancel':
                    interrupt = {'type': 'control_request', 'request_id': 'stop:synthetic',
                        'request': {'subtype': 'interrupt', 'cancel_queued': False,
                                    'for_user_message_uuids': [current]}}
                    channel.client({'id': 4, 'method': 'CancelExecution', 'params': {
                        'owned_handle': channel.handle, 'frame': interrupt}})
                    os.write(writer, encode(interrupt))
                    self.assertEqual(observe()['params']['request_id'], 4)
                    self.assertTrue(channel.control.ack); self.assertFalse(channel.terminal)
                (root / 'release-synthetic-stream').touch()
                pieces = [piece]
                while not channel.terminal or pump.queues[101]:
                    frame = observe()['params']['frame']
                    if frame['type'] == 'assistant': pieces.extend(b['text'] for b in frame['message']['content'])
                    else:
                        self.assertEqual(frame['type'], 'result')
                        if mode == 'complete': self.assertEqual(frame['result'], '')
                        else: self.assertEqual(frame['terminal_reason'], 'aborted_streaming')
                        break
                self.assertEqual(pieces, [piece] * (4 if mode == 'complete' else 1))
                self.assertEqual(len(channel.telemetry_uuids), 2)
                self.assertGreater(channel.wire_bytes, channel.stream.text_bytes)
                os.close(writer); writer = None
                self.assertEqual(pump.child.wait(timeout=5), 0)
                current_stat = Path(f'/proc/{pid}/stat')
                self.assertTrue(not current_stat.exists()
                    or current_stat.read_text().rsplit(')', 1)[1].split()[19] != start)
            finally:
                if writer is not None: os.close(writer)
                parent.close(); handoff.close(); pump.selector.close()
                if pump.child is not None:
                    pump.child.stdout.close()
                    self.assertTrue(reap_owned(pump.child), 'exact owned child cleanup failed')

    def test_actual_partial_progress_precedes_full_block(self):
        self.run_child('complete')

    def test_actual_interrupt_during_partial_output_discards_late_text(self):
        self.run_child('cancel')


if __name__ == '__main__': unittest.main()
