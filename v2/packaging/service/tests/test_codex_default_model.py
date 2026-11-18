"""The plan's Codex default model is checked before a selected package is published."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import beta_config
from beta_config import codex_default_model


def config(**extra):
    value = {"schema_version": 1, "owner_id": "11111111-1111-4111-8111-111111111111",
             "conversation_id": "22222222-2222-4222-8222-222222222222",
             "manager_socket": "/run/synthetic/control.sock", "launcher": "/opt/synthetic/launcher.py",
             "launcher_sha256": "a" * 64, "workspace": "/srv/synthetic", "namespace": "synthetic",
             "supervisor_key": "synthetic-supervisor"}
    value.update(extra)
    return json.dumps(value).encode()


class CodexDefaultModel(unittest.TestCase):
    def test_absent_or_a_codex_launch_model(self):
        codex_default_model({})
        for model in ("gpt-6.1-sol", "gpt-6-sol", "synthetic.model:1"):
            with self.subTest(model=model):
                codex_default_model({"codex_default_model": model})

    def test_never_claude_fable_a_provider_name_or_a_non_model(self):
        for model in ("", "claude-opus-5-5", "Claude", "fable", "gpt-fable-1", "openai", "12345",
                      "bad model", "x" * 121, None, 5, ["gpt-6.1-sol"]):
            with self.subTest(model=model), self.assertRaises(RuntimeError):
                codex_default_model({"codex_default_model": model})

    def test_the_closed_beta_grammar_admits_the_field(self):
        value = beta_config.validate(config(codex_default_model="gpt-6.1-sol"))
        self.assertEqual(value["codex_default_model"], "gpt-6.1-sol")
        with self.assertRaises(RuntimeError):
            beta_config.validate(config(codex_default_model="claude-sonnet"))


if __name__ == "__main__":
    unittest.main()
