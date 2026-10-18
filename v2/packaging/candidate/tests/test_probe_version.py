"""Mocked child queries only; actual Rust CLI remains unexecuted."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import probe_version as probe


class VersionProbeTests(unittest.TestCase):
    def test_queries_exclude_bootstrap_and_do_not_initialize_homes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);binary=root/'binary';binary.write_bytes(b'never executed')
            expected={'component':'server','version':'2.0.0-dev','source_commit':'a'*40}
            def run(command,**kwargs):
                self.assertEqual(command[1:],['--version','--json'])
                self.assertNotIn('ORKESTR_V2_BOOTSTRAP_TOKEN',kwargs['env'])
                self.assertEqual(kwargs['timeout'],5)
                return SimpleNamespace(returncode=0,stdout=json.dumps(expected))
            with patch.object(probe.subprocess,'run',side_effect=run) as child:
                result=probe.check(binary,expected,root)
            self.assertEqual(result['status'],'passed');self.assertEqual(child.call_count,3)
            self.assertEqual(list(root.iterdir()),[binary])

    def test_mutation_and_incorrect_identity_refused_with_cleanup(self):
        for mutate in (False,True):
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);binary=root/'binary';binary.write_bytes(b'never executed')
                expected={'version':'2.0.0-dev'}
                def run(command,**kwargs):
                    if mutate:(kwargs['cwd']/'unexpected').write_text('synthetic')
                    return SimpleNamespace(returncode=0,stdout=json.dumps(expected if mutate else {'version':'2.0.0-rc.1'}))
                with patch.object(probe.subprocess,'run',side_effect=run):
                    with self.assertRaises(RuntimeError):probe.check(binary,expected,root)
                self.assertEqual(list(root.iterdir()),[binary])
