"""Synthetic launcher specification only; no installed Claude invocation."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from claude_connector import ClaudeConfiguration


class ClaudeLauncherTests(unittest.TestCase):
    def test_fresh_session_fixed_options_and_clean_environment(self):
        with tempfile.TemporaryDirectory(prefix="claude-launcher-synthetic-") as root:
            root = Path(root).resolve()
            executable = root / "synthetic-native"
            executable.write_text("synthetic fixture only")
            for name in ("account", "workspace", "home", "tmp"):
                (root / name).mkdir()
            config = ClaudeConfiguration(executable, root / "account", root / "workspace",
                                         root / "home", root / "tmp")
            first, second = config.new_session(), config.new_session()
            self.assertNotEqual(first.native, second.native)
            command = first.command()
            self.assertNotIn("--resume", command)
            self.assertNotIn("--continue", command)
            self.assertEqual(command[command.index("--tools") + 1], "")
            self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "synthetic-secret"}):
                self.assertEqual(set(first.environment()),
                    {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR"})
                self.assertNotIn("synthetic-secret", str(first.environment()))

    def test_alias_account_refused(self):
        with tempfile.TemporaryDirectory(prefix="claude-alias-synthetic-") as root:
            root = Path(root).resolve()
            executable = root / "native"
            executable.write_text("fixture")
            (root / "account").mkdir()
            (root / "alias").symlink_to(root / "account")
            with self.assertRaises(ValueError):
                ClaudeConfiguration(executable, root / "alias", root, root, root).new_session()
