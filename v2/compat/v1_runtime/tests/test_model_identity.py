import unittest
from v2.compat.v1_runtime.model_identity import observed_identity

RUN = "11111111-1111-4111-8111-111111111111"


class ModelIdentityTests(unittest.TestCase):
    def test_exact_run_actual_model_wins_over_configured_alias(self):
        calls = []
        def call(method, path):
            calls.append(path)
            if path == "/settings":
                return {"provider": "codex", "model": "configured-alias"}
            return {"run_id": RUN, "models": {"provider": "claude", "actual_model": "answer-model"}}
        self.assertEqual(observed_identity(call, run_id=RUN), {"provider": "claude", "model": "answer-model", "layer": "deep", "identitySource": "run", "runId": RUN})
        self.assertEqual(calls, ["/execution?run_id=" + RUN])

    def test_legacy_status_never_turns_the_configured_model_into_actual_evidence(self):
        def call(method, path):
            return {"provider": "claude", "model": "configured-alias"} if path == "/settings" else {"run_id": RUN}
        self.assertEqual(observed_identity(call, run_id=RUN), {"model": "unreported", "layer": "deep", "identitySource": "run", "runId": RUN})

    def test_fast_uses_its_exact_run_and_foreign_status_cannot_supply_a_footer(self):
        calls = []
        def call(method, path):
            calls.append(path)
            if path == "/settings": return {"provider": "claude"}
            return {"run_id": "22222222-2222-4222-8222-222222222222", "models": {"actual_model": "foreign-model"}}
        self.assertEqual(observed_identity(call, run_id=RUN, fast=True), {"model": "unreported"})
        self.assertEqual(calls[0], "/fast/execution?run_id=" + RUN)

    def test_policy_notice_identifies_the_refusing_model(self):
        status = {"run_id": RUN, "failure": {"class": "policy"},
                  "models": {"provider": "claude", "resolved_model": "initial-model", "refused_model": "refusing-model"}}
        self.assertEqual(observed_identity(lambda *_: {}, run_id=RUN, status=status),
                         {"provider": "claude", "model": "refusing-model", "layer": "deep", "identitySource": "run", "runId": RUN})

    def test_only_actual_run_effort_is_forwarded(self):
        def forbidden(*_):
            self.fail("no settings lookup may fill observed metadata")
        status = {"run_id": RUN, "reasoning_effort": "xhigh", "models": {"provider": "codex", "actual_model": "synthetic-mini", "actual_reasoning_effort": "low"}}
        result = observed_identity(forbidden, run_id=RUN, status=status, fast=True)
        self.assertEqual(result["observedReasoningEffort"], "low")
        self.assertEqual((result["layer"], result["runId"]), ("fast", RUN))
        del status["models"]["actual_reasoning_effort"]
        self.assertNotIn("observedReasoningEffort", observed_identity(forbidden, run_id=RUN, status=status, fast=True))
        self.assertEqual(observed_identity(forbidden, status=status), {"model": "unreported"})
