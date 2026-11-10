import json
import unittest
import test_recovery_bundle as fixtures
from test_recovery_bundle import uid
from recovery_bundle import make_bundle
from recovery_store_adapter import prepare_restore
from snapshot import Invalid


class StoreAdapterTests(unittest.TestCase):
    def test_preserves_inactive_and_order_and_target_authority(self):
        original, receipt, pages = fixtures.RecoveryBundleTests().sources()
        receipt.update(revision=2, active=False)
        encoded = make_bundle(original, receipt, pages)
        wire = prepare_restore(encoded, restore_id=uid(7), original_namespace=uid(8), delta_namespace=uid(9))
        value = json.loads(wire)
        self.assertEqual(value['bundle']['original'], original)
        self.assertEqual(value['bundle']['current_receipt'], receipt)
        self.assertEqual(value['bundle']['native_delta']['messages'], pages[0]['messages'])
        self.assertEqual(value['original_namespace'], uid(8))
        self.assertNotEqual(value['bundle']['bundle_digest'], json.loads(encoded)['payload_sha256'])
        self.assertEqual(wire, prepare_restore(encoded, restore_id=uid(7), original_namespace=uid(8), delta_namespace=uid(9)))

    def test_refuses_corruption_and_invalid_targets(self):
        encoded = make_bundle(*fixtures.RecoveryBundleTests().sources())
        for targets in [(uid(7), uid(8), uid(8)), (uid(0), uid(8), uid(9)), ('bad', uid(8), uid(9))]:
            with self.assertRaises(Invalid):
                prepare_restore(encoded, restore_id=targets[0], original_namespace=targets[1], delta_namespace=targets[2])
        with self.assertRaises(Invalid):
            prepare_restore(encoded + b' ', restore_id=uid(7), original_namespace=uid(8), delta_namespace=uid(9))
