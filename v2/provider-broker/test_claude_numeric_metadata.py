"""Audit supported numeric metadata against the pinned native and SDK types."""
import unittest

from claude_stream_schema import message_header, stream_envelope, usage
from protocol import Refused
import test_claude_streaming as fixtures


class ClaudeNumericMetadataTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.ClaudeStreamingTests(); self.case.setUp()
        self.channel, self.frames = self.case.channel, self.case.frames

    def test_nullable_usage_containers_and_optional_cache_counts(self):
        value = {'input_tokens': 1, 'output_tokens': 0,
                 'cache_creation_input_tokens': None, 'cache_read_input_tokens': None,
                 'cache_creation': None, 'server_tool_use': None, 'output_tokens_details': None,
                 'service_tier': None, 'inference_geo': None, 'iterations': None,
                 'fallback_credit': None, 'speed': None}
        frame = self.frames.start(); frame['event']['message']['usage'] = value
        self.assertIsNone(self.channel.provider(frame))
        self.channel.provider(self.frames.block())
        self.channel.provider(self.frames.delta('visible'))
        self.channel.provider(self.frames.assistant('visible'))
        self.channel.provider(self.frames.block_stop())
        frame = self.frames.ending(); frame['event']['usage'] = value
        self.assertIsNone(self.channel.provider(frame))
        self.assertFalse(self.channel.terminal)

    def test_nested_usage_counters_are_integers_even_when_container_is_optional(self):
        for key, fields in (
                ('cache_creation', ('ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens')),
                ('server_tool_use', ('web_search_requests', 'web_fetch_requests')),
                ('output_tokens_details', ('thinking_tokens',))):
            with self.subTest(container=key):
                usage({key: {field: 0 for field in fields}})
                for field in fields:
                    for invalid in (None, True, -1, 0.5, 2**53, '0', float('inf')):
                        with self.subTest(field=field, invalid=invalid):
                            value = {key: {name: 0 for name in fields}}
                            value[key][field] = invalid
                            with self.assertRaises(Refused): usage(value)
        with self.assertRaises(Refused): usage({'server_tool_use': {'web_search_requests': 1}})
        with self.assertRaises(Refused): usage({'output_tokens_details': {'unknown': 0}})

    def test_native_timing_and_abandoned_block_types_remain_closed(self):
        for value in (0, 1, 2**53 - 1):
            frame = self.frames.start(); frame['ttft_ms'] = value
            stream_envelope(frame, self.channel.native, self.channel.input_uuid)
        for invalid in (None, True, -1, 0.5, 2**53, float('inf'), '0'):
            with self.subTest(invalid=invalid):
                frame = self.frames.start(); frame['ttft_ms'] = invalid
                with self.assertRaises(Refused):
                    stream_envelope(frame, self.channel.native, self.channel.input_uuid)
                frame = self.frames.stop(); frame['abandoned_blocks'] = {
                    'api_message_id': self.frames.api, 'from_block_index': invalid}
                with self.assertRaises(Refused):
                    stream_envelope(frame, self.channel.native, self.channel.input_uuid)

    def test_supported_stream_display_metadata_never_accepts_null_or_unknown_types(self):
        for kind in ('shown', 'omitted'):
            frame = self.frames.start(); frame['thinking_display'] = kind
            stream_envelope(frame, self.channel.native, self.channel.input_uuid)
        for invalid in (None, True, 1, {}, []):
            frame = self.frames.start(); frame['thinking_display'] = invalid
            with self.assertRaises(Refused):
                stream_envelope(frame, self.channel.native, self.channel.input_uuid)
        header = self.frames.start()['event']['message']
        for key in ('container', 'context_management', 'stop_details', 'diagnostics', 'resumable'):
            message_header(dict(header, **{key: None}), empty=True)
        with self.assertRaises(Refused): usage({'speed': 'unknown'})
        with self.assertRaises(Refused): usage({'iterations': [{'type': 'message'}]})
        with self.assertRaises(Refused): usage({'fallback_credit': {}})


if __name__ == '__main__': unittest.main()
