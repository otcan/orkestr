"""Creating bindings over the loopback API. Synthetic identities only."""
import json
import unittest

from v2.compat.v1_runtime.tests.test_ledger_server import Harness, binding_doc


class ProvisioningTests(Harness):
    def put(self, n, value=None, token=True, path=None):
        value = binding_doc(n, excluded_public_ids=[]) if value is None else value
        return self.request("PUT", path or "/bindings/%s" % self.remote(n), value, token=token)

    def test_creates_a_new_binding_once_and_is_idempotent(self):
        status, value = self.put(3)
        self.assertEqual((status, value["state"]), (200, "enabled"))
        path = self.bindings_dir / (self.remote(3) + ".json")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(path.read_text())["chat_id"], "group-3")
        self.assertEqual(self.post(3)[0], 202)
        # The same request again changes nothing and reports the binding.
        self.assertEqual(self.put(3)[0], 200)
        self.assertEqual(len(self.listing(3)["messages"]), 1)
        # A different document for the same route is refused; the file is unchanged.
        status, value = self.put(3, binding_doc(3, excluded_public_ids=[], enabled=False))
        self.assertEqual((status, value["error"]), (409, "binding_exists"))
        self.assertTrue(json.loads(path.read_text())["enabled"])
        self.assertEqual(self.binding(3).state, "enabled")

    def test_a_disabled_binding_can_be_created(self):
        status, value = self.put(4, binding_doc(4, enabled=False))
        self.assertEqual((status, value["state"]), (200, "disabled"))

    def test_collisions_never_disturb_an_incumbent(self):
        before = (self.bindings_dir / (self.remote(2) + ".json")).read_text()
        status, value = self.put(5, binding_doc(5, chat_id="group-2"))
        self.assertEqual((status, value["error"]), (409, "binding_conflict"))
        self.assertFalse((self.bindings_dir / (self.remote(5) + ".json")).exists())
        self.assertIsNone(self.binding(5))
        self.assertEqual(self.binding(2).state, "enabled")
        self.assertEqual((self.bindings_dir / (self.remote(2) + ".json")).read_text(), before)
        # Existing routes cannot be overwritten through the API.
        self.assertEqual(self.put(1, binding_doc(1, enabled=False))[0], 409)
        self.assertEqual(self.binding(1).state, "enabled")

    def test_refuses_invalid_documents_routes_and_callers(self):
        self.assertEqual(self.put(6, token=False)[0], 401)
        self.assertEqual(self.put(6, binding_doc(7))[1]["error"], "binding_identity")
        self.assertEqual(self.put(6, binding_doc(6, automatic_accept_roles=["fast"]))[0], 400)
        self.assertEqual(self.put(6, binding_doc(6, unexpected=True))[0], 400)
        self.assertEqual(self.put(6, path="/bindings/%s/x" % self.remote(6))[0], 404)
        self.assertEqual(self.put(6, path="/threads/%s" % self.remote(6))[0], 404)
        self.assertEqual(self.put(6, path="/bindings/..%2Fescape")[0], 400)
        self.assertEqual(list(self.bindings_dir.glob("*%s*" % self.remote(6))), [])

    def test_pilot_configuration_cannot_create(self):
        self.config["bindings_dir"] = None
        self.assertEqual(self.put(8)[1]["error"], "bindings_dir_unconfigured")


if __name__ == "__main__":
    unittest.main()
