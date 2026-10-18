"""Exercise the fixed ELF fixture, never a provider or the product server."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


class RecoveryPeerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="v2-recovery-peer-build-")
        cls.binary = Path(cls.build.name) / "peer"
        subprocess.run(["cc", "-O2", "-Wall", "-Wextra", "-Werror", "-o", str(cls.binary),
                        str(Path(__file__).with_name("codex_recovery_peer.c"))], check=True,
                       capture_output=True, timeout=20, env={"PATH": "/usr/bin:/bin"})

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def invoke(self, root, method, text, interrupt=False):
        frames = [{"id": 1, "method": "initialize"}, {"id": 2, "method": method,
                   "params": {"threadId": "synthetic-recovery-session"}},
                  {"id": 3, "method": "turn/start", "params": {
                      "threadId": "synthetic-recovery-session", "input": [{"type": "text", "text": text}]}}]
        if interrupt:
            frames.append({"id": 4, "method": "turn/interrupt"})
        process = subprocess.run([str(self.binary)], input="".join(json.dumps(f) + "\n" for f in frames),
            cwd=root, text=True, capture_output=True, timeout=3, env={"PATH": "/usr/bin:/bin"})
        return process.returncode, [json.loads(line) for line in process.stdout.splitlines()]

    def test_three_owned_processes_require_resume_and_preserve_synthetic_context(self):
        with tempfile.TemporaryDirectory(prefix="v2-recovery-peer-state-") as root:
            code, first = self.invoke(root, "thread/start", "integers 1 through 1000", True)
            self.assertEqual(code, 0)
            self.assertEqual(first[-1]["params"]["turn"]["status"], "interrupted")
            code, second = self.invoke(root, "thread/resume", "RECOVERY_0123456789ab.")
            self.assertEqual(code, 0)
            self.assertEqual(second[-2]["params"]["delta"], "RECOVERY_0123456789ab")
            code, third = self.invoke(root, "thread/resume", "prior token RESTART_01234567.")
            self.assertEqual(code, 0)
            self.assertEqual(third[-2]["params"]["delta"], "RECOVERY_0123456789ab RESTART_01234567")
            trace = [json.loads(line) for line in (Path(root) / "synthetic-recovery-trace.jsonl").read_text().splitlines()]
            self.assertEqual([row["resumed"] for row in trace if row["kind"] == "ready"], [0, 1, 1])
            self.assertEqual([row["step"] for row in trace if row["kind"] == "turn"], [1, 2, 3])
            self.assertEqual(sum(row["kind"] == "interrupt" for row in trace), 1)

    def test_old_held_input_and_fresh_setup_substitution_are_refused(self):
        with tempfile.TemporaryDirectory(prefix="v2-recovery-peer-state-") as root:
            self.assertEqual(self.invoke(root, "thread/start", "integers 1 through 1000", True)[0], 0)
            self.assertEqual(self.invoke(root, "thread/start", "RECOVERY_0123456789ab.")[0], 2)
            self.assertEqual(self.invoke(root, "thread/resume", "HELD_INPUT_MUST_NOT_EXECUTE.")[0], 2)
            self.assertEqual((Path(root) / "synthetic-recovery-state").read_text().strip(), "1")


if __name__ == "__main__":
    unittest.main()
