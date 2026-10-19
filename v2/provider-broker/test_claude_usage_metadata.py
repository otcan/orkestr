"""Pinned usage metadata remains bounded and cannot become output or authority."""
import json
import unittest

from protocol import Refused
import test_claude_streaming as fixtures


class ClaudeUsageMetadataTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.ClaudeStreamingTests(); self.case.setUp()
        self.channel, self.frames = self.case.channel, self.case.frames

    def start(self, update):
        frame = self.frames.start(); frame['event']['message']['usage'].update(update)
        return frame

    def test_speed_is_nullable_closed_metadata_without_progress(self):
        for speed in (None, 'standard', 'fast'):
            with self.subTest(speed=speed):
                self.setUp()
                self.assertIsNone(self.channel.provider(self.start({'speed': speed})))
                self.assertEqual(self.channel.stream.text_bytes, 0)
                self.assertFalse(self.channel.control or self.channel.terminal)
                self.assertNotIn('speed', repr(self.channel.stream.__dict__))

    def test_thinking_token_count_has_strict_nonnegative_integer_bounds(self):
        for count in (0, 1, 2**53 - 1):
            self.setUp()
            self.assertIsNone(self.channel.provider(self.start({
                'output_tokens_details': {'thinking_tokens': count}})))
            self.assertEqual(self.channel.stream.text_bytes, 0)
            self.assertNotIn('thinking_tokens', repr(self.channel.stream.__dict__))
        # Retain the previously accepted alias without reinterpreting either count.
        self.setUp()
        self.assertIsNone(self.channel.provider(self.start({
            'output_tokens_details': {'reasoning_tokens': 1, 'thinking_tokens': 1}})))

    def test_full_message_and_final_delta_validate_then_discard_usage(self):
        metadata = {'speed': 'standard', 'output_tokens_details': {'thinking_tokens': 3}}
        self.channel.provider(self.start(metadata))
        self.channel.provider(self.frames.block())
        output = self.channel.provider(self.frames.delta('visible text'))
        full = self.frames.assistant('visible text'); full['message']['usage'] = metadata
        self.assertIsNone(self.channel.provider(full))
        self.channel.provider(self.frames.block_stop())
        ending = self.frames.ending(); ending['event']['usage'].update(metadata)
        self.assertIsNone(self.channel.provider(ending))
        self.channel.provider(self.frames.stop())
        terminal = self.channel.provider(self.frames.result('visible text'))
        self.assertEqual(output['params']['frame']['message']['content'],
                         [{'type': 'text', 'text': 'visible text'}])
        self.assertEqual(terminal['params']['frame']['result'], '')
        for marker in ('speed', 'thinking_tokens'):
            self.assertNotIn(marker, json.dumps((output, terminal)))

    def test_unknown_malformed_and_nonfinite_usage_fail_closed(self):
        invalid = [{'speed': value} for value in (True, 0, [], {}, '', 'priority',
                                                 'SYNTHETIC_PRIVATE_VALUE')]
        invalid += [{'output_tokens_details': {'thinking_tokens': value}}
                    for value in (True, -1, 1.0, 2**53, None, [], {}, '1')]
        invalid += [{'output_tokens_details': {'unknown': 1}},
                    {'output_tokens_details': {'thinking_tokens': 1, 'unknown': 0}},
                    {'speed': 'fast', 'unknown': None}]
        for update in invalid:
            with self.subTest(update=update):
                self.setUp()
                with self.assertRaises(Refused): self.channel.provider(self.start(update))
                self.assertTrue(self.channel.poisoned)
                self.assertFalse(self.channel.terminal)
        for count in (float('nan'), float('inf'), -float('inf')):
            self.setUp()
            with self.assertRaises(ValueError):
                self.channel.provider(self.start({'output_tokens_details': {'thinking_tokens': count}}))
            self.assertTrue(self.channel.poisoned)

    def test_usage_cannot_supply_cancellation_or_relax_zero_tool_counts(self):
        self.channel.provider(self.start({'speed': 'fast'}))
        self.channel.provider(self.frames.block())
        self.channel.client(self.case.fixture.request())
        self.assertIsNone(self.channel.provider(self.frames.delta('discarded')))
        full = self.frames.assistant('discarded')
        full['message']['usage'] = {'output_tokens_details': {'thinking_tokens': 1}}
        self.assertIsNone(self.channel.provider(full))
        self.assertFalse(self.channel.control.ack or self.channel.terminal)
        self.channel.provider(self.case.fixture.ack())
        self.assertFalse(self.channel.terminal)
        self.setUp()
        with self.assertRaises(Refused):
            self.channel.provider(self.start({'speed': 'standard',
                'server_tool_use': {'web_search_requests': 1}}))
        self.assertFalse(self.channel.terminal)


if __name__ == '__main__': unittest.main()
