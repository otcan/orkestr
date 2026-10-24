"""Policy refusal is an exact-run notice, not a retry suggestion or answer."""
import copy
import unittest

from v2.compat.v1_runtime.policy_refusal import notice
from v2.compat.v1_runtime.tests import test_worker as fixture


def failed(run="deep-run", model="synthetic-model"):
    return {"run_id": run, "phase": "failed", "failure": {"class": "policy"},
            "models": {"provider": "claude", "resolved_model": "synthetic-init",
                       "refused_model": model, "actual_model": "earlier-partial-model"}}


class NoticeTests(unittest.TestCase):
    def test_only_own_explicit_policy_failures_qualify(self):
        self.assertIsNone(notice(failed(), {"foreign"}))
        for change in ({"phase": "running"}, {"failure": {"class": "authentication"}}, {"failure": None}):
            self.assertIsNone(notice({**failed(), **change}, {"deep-run"}))
        result = notice(failed(), {"deep-run"})
        self.assertEqual(result["model"], "synthetic-model")
        self.assertIn("policy refusal", result["text"])
        self.assertNotIn("again", result["text"])
        self.assertNotIn("earlier-partial", result["text"])
        self.assertEqual(notice({**failed(), "phase": "cancelled"}, {"deep-run"}), result)


class PolicyWorkerTests(unittest.TestCase):
    setUp = fixture.WorkerTests.setUp
    def test_policy_failure_exports_one_frozen_notice_without_accepting_or_replaying(self):
        original = self.peer.request
        def request(method, route, **kwargs):
            if method == "GET" and route == "/execution":
                return 200, failed()
            return original(method, route, **kwargs)
        self.peer.request = request
        self.worker.step(self.data)
        self.assertEqual(self.data["phase"], "completed")
        reply = copy.deepcopy(self.ledger.messages()[-1])
        self.assertEqual(reply["refusal"], "provider_policy_refusal")
        self.assertEqual(reply["model"], "synthetic-model")
        self.assertIn("policy refusal", reply["text"])
        self.assertNotIn("again", reply["text"])
        self.assertNotIn("deep", self.peer.accepted)
        self.ledger.refuse(self.data, "provider_policy_refusal", notice=notice(failed(model="changed"), {"deep-run"}))
        self.assertEqual(self.ledger.messages()[-1], reply)


if __name__ == "__main__":
    unittest.main()
