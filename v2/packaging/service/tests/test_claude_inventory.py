"""The selected packager and manager must agree on the complete Claude codec."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'v2/packaging/service'))
import selected
from manager_source import authority
import subprocess

SOURCE = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()


class ClaudeInventoryTests(unittest.TestCase):
    def test_current_manager_policy_codec_is_packaged(self):
        with authority(ROOT, SOURCE) as (_, manager, _):
            self.assertEqual(selected.claude_inventory(manager), manager.CLAUDE_FILES)
            self.assertIn('broker/claude_policy.py', manager.CLAUDE_FILES)
            self.assertIn('broker/startup_diagnostics.py', manager.CLAUDE_FILES)

    def test_missing_extra_or_substituted_codec_is_refused(self):
        with authority(ROOT, SOURCE) as (_, manager, _):
            current = manager.CLAUDE_FILES.copy()
        for files in (current - {'broker/claude_policy.py'},
                      current - {'broker/startup_diagnostics.py'}, current | {'broker/unreviewed.py'},
                      (current - {'broker/claude_policy.py'}) | {'broker/substitute.py'}):
            with self.assertRaisesRegex(RuntimeError, 'manager Claude inventory required'):
                selected.claude_inventory(SimpleNamespace(CLAUDE_FILES=files))


if __name__ == '__main__':
    unittest.main()
