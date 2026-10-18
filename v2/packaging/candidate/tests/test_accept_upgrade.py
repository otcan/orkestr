"""Synthetic exact-input upgrade preflight; no server or migration executed."""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import accept_upgrade


class UpgradePlanTests(unittest.TestCase):
    def setUp(self):
        self.old={'source_commit':'a'*40,'version':'2.0.0-rc.1','schema':{'migrations':{f'{i:04d}_fixture.sql':'c'*64 for i in range(1,18)}}}
        self.new=copy.deepcopy(self.old);self.new['source_commit']='b'*40
        self.new['schema']['migrations'].update({f'{i:04d}_fixture.sql':'d'*64 for i in range(18,25)})

    def plan(self,old_sha='e'*64):
        with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]), patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)):
            return accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,old_sha,'f'*64)

    def test_17_to24_prepares_without_execution_or_repackaging(self):
        with patch.object(accept_upgrade.cross_revision,'exercise',side_effect=AssertionError('must not execute')):
            value=self.plan()
        self.assertEqual(value['status'],'prepared_only_unexecuted')
        self.assertEqual((value['old_schema'],value['new_schema']),(17,24))
        self.assertEqual(value['new_version'],'2.0.0-rc.1')

    def test_changed_historical_migration_refused(self):
        self.new['schema']['migrations']['0001_fixture.sql']='d'*64
        with self.assertRaisesRegex(RuntimeError,'historical migration checksum'):self.plan()

    def test_wrong_pin_and_missing_migration_refused(self):
        with self.assertRaisesRegex(RuntimeError,'binary mismatch'):self.plan('0'*64)
        del self.new['schema']['migrations']['0018_fixture.sql']
        with self.assertRaisesRegex(RuntimeError,'contiguous'):self.plan()

    def test_unsupported_host_refused_before_server(self):
        with patch.object(accept_upgrade.platform,'system',return_value='Darwin'):
            with self.assertRaisesRegex(RuntimeError,'Linux x86_64'):accept_upgrade.host_target()
        with patch.object(accept_upgrade.platform,'system',return_value='Linux'),patch.object(accept_upgrade.platform,'machine',return_value='aarch64'):
            with self.assertRaisesRegex(RuntimeError,'Linux x86_64'):accept_upgrade.host_target()

    def test_execute_retains_original_packages(self):
        plan=self.plan()
        with patch.object(accept_upgrade,'host_target'),patch.object(accept_upgrade.cross_revision,'exercise',return_value={'status':'synthetic'}) as run:
            accept_upgrade.execute(plan,Path('/old'),Path('/new'),Path('/private'),19842)
        args=run.call_args.args[0]
        self.assertEqual(args.old_package,Path('/old/native'))
        self.assertEqual(args.new_package,Path('/new/native'))
        self.assertEqual(args.new_schema,24)
