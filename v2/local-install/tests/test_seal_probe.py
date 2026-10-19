import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('seal_probe', Path(__file__).parents[1]/'seal_probe.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SealProbeTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.repo = self.root/'repo'
        self.repo.mkdir()
        self.entry = 'v2/local-install/probe.py'
        self.file = self.repo/self.entry
        self.file.parent.mkdir(parents=True)
        self.file.write_text("raise RuntimeError('must never execute')\n")
        for args in [('init', '-q'), ('add', '.'), ('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')]:
            subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True)
        self.output = self.root/'sealed'

    def test_seals_committed_bytes_and_planned_argv_without_execution(self):
        plan = json.loads(module.seal(self.repo, self.output, self.entry, ['--fixture', 'synthetic']).read_text())
        self.assertEqual(plan['status'], 'prepared_unexecuted')
        self.assertEqual(plan['argv'][-2:], ['--fixture', 'synthetic'])
        self.assertEqual((self.output/'closure'/self.entry).read_bytes(), self.file.read_bytes())
        self.assertIn(self.entry, plan['inventory'])
        with self.assertRaisesRegex(RuntimeError, 'fresh output'):
            module.seal(self.repo, self.output, self.entry, [])

    def test_changed_source_refuses_before_output(self):
        self.file.write_text('changed\n')
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            module.seal(self.repo, self.output, self.entry, [])
        self.assertFalse(self.output.exists())

    def test_uncommitted_entry_refuses(self):
        with self.assertRaisesRegex(RuntimeError, 'committed'):
            module.seal(self.repo, self.output, '../outside.py', [])
        self.assertFalse(self.output.exists())
