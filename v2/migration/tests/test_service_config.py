"""Explicit unattended timer mode cannot fall back to human credentials."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('timer_config_client',ROOT/'v2_client.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
spec=importlib.util.spec_from_file_location('timer_config_cli',ROOT/'thread_timers.py')
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)

class Tests(unittest.TestCase):
    def test_missing_service_config_never_reads_human_credentials_or_login(self):
        client=c.Client('http://127.0.0.1:19822',origin='https://example.invalid')
        with tempfile.TemporaryDirectory() as tmp,patch.object(client,'login',side_effect=AssertionError('human login')):
            with self.assertRaises(RuntimeError):client.login_service_config(Path(tmp)/'missing')
        self.assertIsNone(client.service_config)

    def test_cli_auth_modes_are_mutually_exclusive_and_explicit(self):
        parser=t.parser()
        args=['handoff','--bundle','synthetic','--thread','thread','--conversation','conv','--v2-url','http://127.0.0.1:19822']
        parsed=parser.parse_args(args+['--service-config','/protected/service.json'])
        self.assertEqual(parsed.service_config,'/protected/service.json');self.assertIsNone(parsed.credentials_file)
        with patch('sys.stderr'),self.assertRaises(SystemExit):
            parser.parse_args(args+['--service-config','/protected/service.json','--credentials-file','/owner'])

    def test_config_mode_close_keeps_shared_service_session(self):
        client=c.Client('http://127.0.0.1:19822');client.service_config=object()
        with patch.object(client,'_send',side_effect=AssertionError('logout')):client.close()
        self.assertIsNone(client.service_config)

if __name__=='__main__':unittest.main()
