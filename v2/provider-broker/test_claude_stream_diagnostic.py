"""Closed structural diagnosis must disclose no native content or grant authority."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

from claude_stream_diagnostic import (
    EXTRA_LIMIT, MESSAGE_OPTIONAL_KEYS, MESSAGE_REQUIRED_KEYS,
    message_header_shape, valid_header_shape,
)
from claude_stream_schema import message_header
from protocol import Refused


class ClaudeHeaderDiagnosticTests(unittest.TestCase):
    def header(self):
        return {'id': 'synthetic-api-message', 'role': 'assistant', 'content': []}

    def test_each_required_key_and_combined_failure_are_distinguishable(self):
        for i, key in enumerate(MESSAGE_REQUIRED_KEYS):
            with self.subTest(key=key):
                header = self.header(); del header[key]
                shape = message_header_shape(header)
                self.assertEqual(shape['kind'], 'missing_required')
                self.assertEqual(shape['required_mask'], 7 ^ (1 << i))
                self.assertEqual(shape['extra_count'], 0)
                self.assertTrue(valid_header_shape(shape))
                header['SYNTHETIC_UNKNOWN_KEY'] = 'SYNTHETIC_VALUE'
                shape = message_header_shape(header)
                self.assertEqual(shape['kind'], 'missing_required')
                self.assertEqual(shape['extra_count'], 1)
                self.assertTrue(valid_header_shape(shape))

    def test_each_existing_optional_bit_is_fixed_and_does_not_accept_unknown(self):
        self.assertEqual(MESSAGE_REQUIRED_KEYS, ('id', 'role', 'content'))
        self.assertEqual(MESSAGE_OPTIONAL_KEYS, (
            'type', 'model', 'stop_reason', 'stop_sequence', 'usage', 'container',
            'context_management', 'stop_details', 'diagnostics', 'resumable',
            'input_transformations'))
        for i, key in enumerate(MESSAGE_OPTIONAL_KEYS):
            with self.subTest(key=key):
                header = self.header(); header[key] = None
                shape = message_header_shape(header)
                self.assertEqual(shape['kind'], 'closed_keys')
                self.assertEqual(shape['optional_mask'], 1 << i)
                self.assertTrue(valid_header_shape(shape))
        header = self.header(); header['SYNTHETIC_UNKNOWN_KEY'] = None
        self.assertEqual(message_header_shape(header)['kind'], 'extra_fields')
        with self.assertRaises(Refused): message_header(header, empty=True)

    def test_key_projection_is_not_value_validation(self):
        header = self.header(); header['role'] = 'SYNTHETIC_NOT_ASSISTANT'
        shape = message_header_shape(header)
        self.assertEqual(shape['kind'], 'closed_keys')
        self.assertTrue(valid_header_shape(shape))
        with self.assertRaises(Refused): message_header(header)
        message_header(self.header(), empty=True)

    def test_non_objects_and_dict_subclass_hooks_are_never_read(self):
        class Poison(dict):
            def __len__(self): raise AssertionError('length hook read')
            def __contains__(self, key): raise AssertionError('membership hook read')
            def __iter__(self): raise AssertionError('iteration hook read')
            def __repr__(self): raise AssertionError('repr hook read')
        for value in (None, False, 3, 1.5, 'SYNTHETIC_CONTENT', [], Poison()):
            shape = message_header_shape(value)
            self.assertEqual(shape, dict(version=2, kind='not_object', required_mask=0,
                                         optional_mask=0, extra_count=0, extra_overflow=False))
            self.assertTrue(valid_header_shape(shape))

    def test_projection_does_not_observe_retain_or_serialize_values(self):
        class Poison:
            def __repr__(self): raise AssertionError('repr read')
            def __str__(self): raise AssertionError('string read')
            def __iter__(self): raise AssertionError('iteration read')
            def __len__(self): raise AssertionError('length read')
        header = dict.fromkeys(MESSAGE_REQUIRED_KEYS + MESSAGE_OPTIONAL_KEYS, Poison())
        header['SYNTHETIC_KEY_MUST_NOT_LEAVE'] = {'SYNTHETIC_VALUE_MUST_NOT_LEAVE': Poison()}
        shape = message_header_shape(header)
        raw = json.dumps(shape, allow_nan=False)
        self.assertNotIn('SYNTHETIC', raw)
        self.assertEqual(shape['required_mask'], 7)
        self.assertEqual(shape['optional_mask'], 2047)
        self.assertEqual(shape['extra_count'], 1)
        self.assertTrue(valid_header_shape(json.loads(raw)))
        self.assertLess(len(raw.encode()), 160)

    def test_extra_count_saturates_and_has_no_arbitrary_key_hashes(self):
        for count in (0, 1, EXTRA_LIMIT, EXTRA_LIMIT + 1, 1000):
            with self.subTest(count=count):
                header = self.header()
                header.update({f'SYNTHETIC_PRIVATE_{i}': 'SYNTHETIC_VALUE' for i in range(count)})
                shape = message_header_shape(header)
                self.assertEqual(shape['extra_count'], min(count, EXTRA_LIMIT))
                self.assertIs(shape['extra_overflow'], count > EXTRA_LIMIT)
                self.assertTrue(valid_header_shape(shape))
                raw = json.dumps(shape, allow_nan=False)
                self.assertNotIn('SYNTHETIC', raw)
                self.assertLess(len(raw.encode()), 160)

    def test_closed_collector_schema_rejects_types_ranges_and_inconsistency(self):
        shape = message_header_shape(self.header())
        for key in shape:
            altered = dict(shape); del altered[key]
            self.assertFalse(valid_header_shape(altered))
        for key, values in (
                ('version', (True, 0, 1, 2.0, '2')),
                ('kind', (None, 1, [], 'unknown', 'not_object', 'missing_required', 'extra_fields')),
                ('required_mask', (-1, 8, True, 7.0, '7', None)),
                ('optional_mask', (-1, 2048, True, 0.0, '0', None)),
                ('extra_count', (-1, 65, True, 0.0, '0', None)),
                ('extra_overflow', (None, 0, 1, 'false', True))):
            for value in values:
                with self.subTest(key=key, value=value):
                    self.assertFalse(valid_header_shape(dict(shape, **{key: value})))
        self.assertFalse(valid_header_shape(dict(shape, arbitrary='SYNTHETIC_VALUE')))
        for value in (None, [], False, 'synthetic'):
            self.assertFalse(valid_header_shape(value))
        partial = message_header_shape({})
        self.assertFalse(valid_header_shape(dict(partial, kind='closed_keys')))
        self.assertFalse(valid_header_shape(dict(partial, extra_overflow=True)))

    def test_standalone_exact_path_import_needs_no_broker_search_path(self):
        path = Path(__file__).with_name('claude_stream_diagnostic.py').resolve()
        program = '''import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('pinned_diagnostic', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assert 'claude_stream_schema' not in sys.modules and 'protocol' not in sys.modules
shape = module.message_header_shape({'id': '', 'role': '', 'content': []})
assert module.valid_header_shape(shape)
print(json.dumps(shape, sort_keys=True))
'''
        completed = subprocess.run([sys.executable, '-I', '-B', '-c', program, str(path)],
                                   capture_output=True, text=True, timeout=5, check=True)
        self.assertEqual(json.loads(completed.stdout)['kind'], 'closed_keys')
        self.assertEqual(completed.stderr, '')


if __name__ == '__main__':
    unittest.main()
