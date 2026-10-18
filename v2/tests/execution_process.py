"""Actual read-only execution route; synthetic owner and isolated server only."""
import unittest
import uuid

from intake_process import IntakeAcceptance


class ExecutionReadAcceptance(IntakeAcceptance):
    def test_execution_absence_queue_and_reopen(self):
        cookie, _ = self.browser_login()
        path = f"/conversations/{self.conversation}/execution"
        code, body, headers = self.browser_request("GET", path, cookie=cookie)
        self.assertEqual((code, body), (204, None))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.admit()[0], 202)
        before = self.durable_rows()
        code, first, _ = self.browser_request("GET", path, cookie=cookie)
        self.assertEqual(code, 200, first)
        self.assertEqual(first["conversation_id"], self.conversation)
        self.assertEqual(first["phase"], "queued")
        self.assertIsNone(first["run_id"])
        self.assertEqual(first["capabilities"], {"stop": False, "steer": False})
        self.assertIsNone(first["progress"])
        self.assertIsNone(first["resources"])
        self.assertEqual(self.durable_rows(), before)
        self.stop()
        self.start()
        code, reopened, _ = self.browser_request("GET", path, cookie=cookie)
        self.assertEqual(code, 200, reopened)
        for field in ("revision", "run_id", "conversation_id", "phase", "capabilities"):
            self.assertEqual(reopened[field], first[field])
        self.assertEqual(self.durable_rows(), before)

    def test_execution_auth_scope_host_origin_and_no_controls(self):
        cookie, csrf = self.browser_login()
        path = f"/conversations/{self.conversation}/execution"
        before = self.durable_rows()
        status, body, _ = self.browser_request("POST", f"/conversations/{self.conversation}/stop", {"run_id": str(uuid.uuid4()), "expected_revision": 0, "request_key": "stop:unbound"}, cookie=cookie, csrf=csrf)
        self.assertEqual(status, 503, body)
        self.assertEqual(self.durable_rows(), before)
        self.assertEqual(self.browser_request("GET", path)[0], 403)
        self.assertEqual(self.browser_request("GET", path, headers={"Origin": None})[0], 401)
        for headers in ({"Origin": "https://foreign.test"}, {"Host": "foreign.test"}):
            self.assertEqual(self.browser_request("GET", path, cookie=cookie, headers=headers)[0], 403)
        self.assertEqual(self.browser_request("GET", "/conversations/invalid/execution", cookie=cookie)[0], 400)
        self.assertEqual(self.browser_request("GET", f"/conversations/{uuid.uuid4()}/execution", cookie=cookie)[0], 404)
        self.assertEqual(self.browser_request("GET", path, cookie=cookie, headers={"Authorization": "Bearer " + self.token})[0], 401)
        # Nested guessed control paths remain absent; Stop is a sibling route.
        for action in ("stop", "steer"):
            self.assertEqual(self.browser_request("GET", f"{path}/{action}", cookie=cookie)[0], 404)


if __name__ == "__main__":
    # Reuse bootstrap/owned-process cleanup, without rerunning inherited suites.
    suite = unittest.TestSuite(ExecutionReadAcceptance(name) for name in (
        "test_execution_absence_queue_and_reopen",
        "test_execution_auth_scope_host_origin_and_no_controls",
    ))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
