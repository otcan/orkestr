import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('desktop_control', Path(__file__).resolve().parents[1] / 'desktop_control.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)

CONFIG = {
    'format': 'orkestr-desktop-control-v1', 'v2_url': 'http://127.0.0.1:19822',
    'conversation_id': '11111111-1111-4111-8111-111111111111',
    'v1_thread_id': 'worker-abc_1:x', 'desktop_slug': 'example-desk',
    'grant_file': '/etc/example/grant.env', 'broker_file': '/etc/example/broker.json',
    'broker_uid': 1001, 'framebuffer_port': 15900,
    'framebuffer_unit': 'example-x11vnc.service', 'state_directory': '/var/lib/example/state',
    'output_directory': '/var/lib/example/images', 'output_uid': 1002, 'output_gid': 1002,
}


class ThreadIdContractTests(unittest.TestCase):
    def configured(self, **changes):
        data = json.dumps({**CONFIG, **changes}).encode()
        with patch.object(controller, 'read', return_value=data), patch.object(controller, 'protected'):
            return controller.configuration('/etc/example/config.json')

    def test_v1_contract_accepts_uuid_legacy_hex_and_worker_ids(self):
        for value in ['22222222-2222-4222-8222-222222222222', '0123456789abcdef', 'worker-abc_1:x', 'x' * 200]:
            self.assertEqual(self.configured(v1_thread_id=value)['v1_thread_id'], value)

    def test_invalid_v1_identifiers_are_refused(self):
        for value in ['', 'x' * 201, 'a/b', 'a b', 'a\nb', 'ü', None, 123]:
            with self.assertRaisesRegex(ValueError, 'controller_thread_id_invalid'):
                self.configured(v1_thread_id=value)

    def test_v2_conversation_still_requires_uuid(self):
        with self.assertRaises(ValueError):
            self.configured(conversation_id='0123456789abcdef')


if __name__ == '__main__':
    unittest.main()
