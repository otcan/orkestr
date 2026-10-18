import json
from pathlib import Path
import tempfile
import unittest
from configuration import Configuration


class ConfigurationTests(unittest.TestCase):
    def test_private_schema_rejects_extra_environment_and_relative_paths(self):
        with tempfile.TemporaryDirectory(prefix="broker-config-synthetic-") as directory:
            root = Path(directory).resolve()
            executable = root / "fake-provider"
            executable.write_text("synthetic; never executed")
            value = {"codex_executable": str(executable), "codex_home": str(root),
                     "workspace": str(root), "home": str(root), "temporary": str(root)}
            config = root / "private.json"
            config.write_text(json.dumps(value))
            loaded = Configuration.load(config)
            self.assertEqual(loaded.command(), [str(executable), "app-server", "--listen", "stdio://"])
            for changed in [dict(value, environment={"TOKEN": "fake"}), dict(value, codex_home="relative")]:
                config.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    Configuration.load(config)
            alias = root / "alias"
            alias.symlink_to(executable)
            config.write_text(json.dumps(dict(value, codex_executable=str(alias))))
            with self.assertRaises(ValueError):
                Configuration.load(config)
