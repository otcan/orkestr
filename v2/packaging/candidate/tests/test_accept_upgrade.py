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

    def test_future_inventory_inspection_never_admits_execution(self):
        for successor in (25,26,32,35):
            self.new['schema']['migrations'].update({f'{i:04d}_fixture.sql':'d'*64 for i in range(25,successor+1)})
            with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]),patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)),patch.object(accept_upgrade,'source_inventory',return_value='1'*64),patch.object(accept_upgrade,'sqlx_inventory',return_value={}):
                plan=accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,successor,Path('/core-migrations'))
            self.assertEqual(plan['status'],'pending_core_edge_admission')
            with patch.object(accept_upgrade.cross_revision,'exercise') as run,self.assertRaisesRegex(RuntimeError,'inspection only'):
                accept_upgrade.execute(plan,Path('/old'),Path('/new'),Path('/private'),19842)
            run.assert_not_called()

    def test_exact_source_inventory_rejects_changed_content(self):
        import tempfile
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);(root/'0001_fixture.sql').write_text('synthetic SQL')
            with self.assertRaisesRegex(RuntimeError,'source inventory mismatch'):
                accept_upgrade.source_inventory(root,{'0001_fixture.sql':'0'*64})
            expected={'0001_fixture.sql':accept_upgrade.receipt.sha(root/'0001_fixture.sql')}
            self.assertEqual(accept_upgrade.source_inventory(root,expected),accept_upgrade.receipt.digest(expected))


    def test_sqlx_digest_uses_the_same_verified_core_source_bytes(self):
        import hashlib
        import tempfile
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);data=b'-- public synthetic SQL\n';(root/'0001_fixture.sql').write_bytes(data)
            inventory={'0001_fixture.sql':hashlib.sha256(data).hexdigest()}
            self.assertEqual(accept_upgrade.sqlx_inventory(root,inventory),{'1':hashlib.sha384(data).hexdigest()})
            (root/'0001_fixture.sql').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError,'changed while preparing'):accept_upgrade.sqlx_inventory(root,inventory)

    def test_core_admitted_17_to28_requires_exact_source_checksums(self):
        self.new['schema']['migrations'].update({f'{i:04d}_fixture.sql':'d'*64 for i in range(25,29)})
        for supplied in (False,True):
            with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]),patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)),patch.object(accept_upgrade,'source_inventory',return_value='1'*64),patch.object(accept_upgrade,'sqlx_inventory',return_value={str(i):'a'*96 for i in range(1,29)}):
                if supplied:
                    plan=accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,28,Path('/core'))
                    self.assertTrue(plan['execution_edge_admitted']);self.assertEqual(len(plan['sqlx_checksums']),28)
                    self.assertEqual(plan['status'],'prepared_only_unexecuted')
                else:
                    with self.assertRaisesRegex(RuntimeError,'exact Core sources'):
                        accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,28)

    def test_schema31_requires_reviewed_inventory_and_sqlx_checksums(self):
        self.new['schema']['migrations'].update({f'{i:04d}_fixture.sql':'d'*64 for i in range(25,32)})
        for digest in (accept_upgrade.SCHEMA31_INVENTORY,'0'*64):
            with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]),patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)),patch.object(accept_upgrade,'source_inventory',return_value=digest),patch.object(accept_upgrade,'sqlx_inventory',return_value={str(i):'a'*96 for i in range(1,32)}):
                if digest==accept_upgrade.SCHEMA31_INVENTORY:
                    plan=accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,31,Path('/core'))
                    self.assertTrue(plan['execution_edge_admitted'])
                    self.assertEqual(len(plan['sqlx_checksums']),31)
                else:
                    with self.assertRaisesRegex(RuntimeError,'reviewed Core413'):
                        accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,31,Path('/core'))
        with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]),patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)):
            with self.assertRaisesRegex(RuntimeError,'exact Core sources'):
                accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,31)

    def test_schema33_requires_exact_immutable_inventory(self):
        self.new['schema']['migrations'].update({f'{i:04d}_fixture.sql':'d'*64 for i in range(25,34)})
        for digest in (accept_upgrade.SCHEMA33_INVENTORY,'0'*64):
            with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]),patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)),patch.object(accept_upgrade,'source_inventory',return_value=digest),patch.object(accept_upgrade,'sqlx_inventory',return_value={str(i):'a'*96 for i in range(1,34)}):
                if digest==accept_upgrade.SCHEMA33_INVENTORY:
                    plan=accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,33,Path('/core'))
                    self.assertTrue(plan['execution_edge_admitted'])
                    self.assertEqual(len(plan['sqlx_checksums']),33)
                else:
                    with self.assertRaisesRegex(RuntimeError,'reviewed Core941'):
                        accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,33,Path('/core'))

    def test_schema31_to33_keeps_exact_prior_prefix(self):
        self.new['schema']['migrations'].update({f'{i:04d}_fixture.sql':'d'*64 for i in range(25,34)})
        self.old['schema']['migrations']=dict(list(self.new['schema']['migrations'].items())[:31])
        with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]),patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)),patch.object(accept_upgrade,'source_inventory',return_value=accept_upgrade.SCHEMA33_INVENTORY),patch.object(accept_upgrade,'sqlx_inventory',return_value={str(i):'a'*96 for i in range(1,34)}):
            plan=accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,33,Path('/core'))
            self.assertTrue(plan['execution_edge_admitted'])
            self.assertEqual(plan['old_schema'],31)

    def test_schema34_inspection_requires_exact_inventory_but_not_execution(self):
        self.new['schema']['migrations'].update({f'{i:04d}_fixture.sql':'d'*64 for i in range(25,35)})
        for digest in (accept_upgrade.SCHEMA34_INVENTORY,'0'*64):
            with patch.object(accept_upgrade.package_candidate,'verify',side_effect=[self.old,self.new]),patch.object(accept_upgrade.receipt,'sha',side_effect=lambda p:('e'*64 if str(p).startswith('/old') else 'f'*64)),patch.object(accept_upgrade,'source_inventory',return_value=digest),patch.object(accept_upgrade,'sqlx_inventory',return_value={str(i):'a'*96 for i in range(1,35)}):
                if digest==accept_upgrade.SCHEMA34_INVENTORY:
                    plan=accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,34,Path('/core'))
                    self.assertFalse(plan['execution_edge_admitted'])
                    with patch.object(accept_upgrade.cross_revision,'exercise') as run,self.assertRaisesRegex(RuntimeError,'inspection only'):
                        accept_upgrade.execute(plan,Path('/old'),Path('/new'),Path('/private'),19842)
                    run.assert_not_called()
                else:
                    with self.assertRaisesRegex(RuntimeError,'published Core63366'):
                        accept_upgrade.prepare(Path('/old'),Path('/new'),'a'*40,'b'*40,'e'*64,'f'*64,34,Path('/core'))
