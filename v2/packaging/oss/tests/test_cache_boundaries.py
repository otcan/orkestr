"""The probe must distinguish a scheduled vertex from actual setup execution."""
import importlib.util
import base64
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    'cache_boundaries', Path(__file__).resolve().parents[1] / 'cache_boundaries.py')
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class CacheProgressTests(unittest.TestCase):
    def test_cached_result_is_merged_without_losing_start_or_name(self):
        events = [{'id': 'setup', 'name': '[tooling 4/5] RUN apt-get update'},
                  {'id': 'setup', 'name': '[tooling 4/5] RUN apt-get update',
                   'started': '2026-01-01T00:00:00Z'},
                  {'id': 'setup', 'name': '[tooling 4/5] RUN apt-get update', 'cached': True},
                  {'id': 'source', 'name': '[source 1/1] RUN git fetch'}]
        vertices = probe.setup_events(events)
        self.assertEqual(len(vertices), 1)
        self.assertTrue(vertices[0]['cached'])
        self.assertTrue(vertices[0]['started'])

    def test_unexecuted_vertex_cannot_count_as_setup_started_or_cache_hit(self):
        vertex = probe.setup_events([
            {'id': 'setup', 'name': '[runtime 3/5] RUN apt-get install python3'}])[0]
        self.assertFalse(vertex.get('started'))
        self.assertFalse(vertex.get('cached'))

    def test_buildkit_status_envelopes_retain_real_vertex_updates(self):
        events = [{'vertexes': [{'digest': 'setup', 'name': '[tooling 4/5] RUN apt-get update'}]},
                  {'vertexes': [{'digest': 'setup', 'name': '[tooling 4/5] RUN apt-get update',
                                 'started': '2026-01-01T00:00:00Z', 'cached': True}]}]
        self.assertTrue(probe.setup_events(events)[0]['cached'])
        self.assertTrue(probe.setup_events(events)[0]['started'])

    def test_refusal_requires_actual_error_and_decoded_log_not_just_instruction_text(self):
        message = 'SOURCE_COMMIT must be the exact 40-character public commit'
        event = {'name': '[source-check 2/2] RUN ' + message,
                 'started': '2026-01-01T00:00:00Z', 'completed': '2026-01-01T00:00:00.25Z',
                 'error': 'exit code 1'}
        events = [{'vertexes': [event]}]
        with self.assertRaisesRegex(RuntimeError, 'actual source-validation'):
            probe.refusal_seconds(events)
        events.append({'logs': [{'data': base64.b64encode(message.encode()).decode()}]})
        self.assertEqual(probe.refusal_seconds(events), .25)


if __name__ == '__main__':
    unittest.main()
