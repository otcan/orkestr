"""Exact schema41 upgrade gate preparation, never package/binary execution."""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import accept_upgrade

PINS=json.loads((Path(__file__).resolve().parents[3]/'local-install/tests/schema41-fingerprints.json').read_text())
SOURCE=Path(os.environ.get('ORKESTR_V2_MIGRATIONS_DIR','/nonexistent-source'))


@unittest.skipUnless((SOURCE/'0041_memory_authority.sql').is_file(),'exact schema41 SQL not supplied')
class Schema41UpgradeGateTests(unittest.TestCase):
    def prepare(self, predecessor, migrations=SOURCE, changed=False):
        inventory={r['file']:r['sha256'] for r in PINS['migrations']}
        old={'source_commit':'a'*40,'version':'2.0.0-dev','schema':{'migrations':dict(list(inventory.items())[:predecessor])}}
        if changed: old['schema']['migrations'][next(iter(inventory))]='0'*64
        new={'source_commit':'b'*40,'version':'2.0.0-dev','schema':{'migrations':inventory}}
        with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[old,new]), \
             patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p: 'e'*64 if str(p).startswith('/old') else
                          'f'*64 if str(p).startswith('/new') else __import__('hashlib').sha256(p.read_bytes()).hexdigest()), \
             patch.object(accept_upgrade.cross_revision,'exercise',side_effect=AssertionError('no executable admission run')):
            return accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,41,migrations)

    def test_nine_edges_require_exact_inventory_and_remain_unexecuted(self):
        for predecessor in PINS['supported_prefixes']:
            with self.subTest(prefix=predecessor):
                plan=self.prepare(predecessor)
                self.assertEqual(plan['status'],'prepared_only_unexecuted')
                self.assertTrue(plan['execution_edge_admitted'])
                self.assertEqual(plan['core_source_inventory_sha256'],accept_upgrade.SCHEMA41_INVENTORY)
                self.assertEqual(plan['sqlx_checksums'],{str(r['version']):r['sqlx_sha384'] for r in PINS['migrations']})

    def test_missing_sources_and_changed_prefix_refuse(self):
        with self.assertRaisesRegex(RuntimeError,'exact Core sources'): self.prepare(39,None)
        with self.assertRaisesRegex(RuntimeError,'historical migration checksum'): self.prepare(39,changed=True)
