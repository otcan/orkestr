"""Synthetic owner callbacks only: no canonical auth or native refresh."""
import os
from pathlib import Path
import tempfile
import threading
import unittest
from isolation.managed_codex import ManagedCodexOwner


class ManagedCodexTests(unittest.TestCase):
    def test_atomic_replacement_stales_handle_and_fresh_launch_reloads(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'synthetic-account';path.write_text('old synthetic bytes')
            record={'identity':'synthetic-selected','generation':1,'state':'ready'}
            def refresh():
                replacement=path.with_suffix('.replacement')
                replacement.write_text('new synthetic bytes');os.replace(replacement,path)
                record['generation']+=1
            owner=ManagedCodexOwner('synthetic-selected',lambda:dict(record),path.read_text,
                                    supported_refresh=refresh)
            old=owner.select();fresh=owner.refresh()
            with self.assertRaises(ValueError):old.launch()
            self.assertEqual(fresh.launch(),'new synthetic bytes')
            with self.assertRaises(ValueError):fresh.launch()

    def test_concurrent_refresh_serialized_and_launch_cannot_interleave(self):
        record={'identity':'synthetic-selected','generation':0,'state':'ready'}
        entered=threading.Event();release=threading.Event();attempted=threading.Event()
        active=[];seen=[];errors=[]
        def refresh():
            active.append(1)
            if len(active)!=1:errors.append('overlap')
            entered.set()
            if not release.wait(2):raise ValueError()
            record['generation']+=1;active.pop()
        owner=ManagedCodexOwner('synthetic-selected',lambda:dict(record),
            lambda:seen.append(record['generation']),supported_refresh=refresh)
        old=owner.select()
        first=threading.Thread(target=owner.refresh)
        def second():
            attempted.set();owner.refresh()
        first.start();self.assertTrue(entered.wait(2))
        other=threading.Thread(target=second);other.start();self.assertTrue(attempted.wait(2))
        release.set();first.join(2);other.join(2)
        self.assertFalse(first.is_alive() or other.is_alive())
        self.assertEqual(record['generation'],2);self.assertEqual(errors,[])
        with self.assertRaises(ValueError):old.launch()
        owner.select().launch();self.assertEqual(seen,[2])

    def test_revocation_identity_change_and_unsupported_refresh_refuse(self):
        record={'identity':'synthetic-selected','generation':1,'state':'ready'}
        launched=[]
        owner=ManagedCodexOwner('synthetic-selected',lambda:dict(record),lambda:launched.append(1))
        with self.assertRaisesRegex(ValueError,'managed refresh unavailable'):owner.refresh()
        handle=owner.select();record['state']='revoked'
        with self.assertRaises(ValueError):handle.launch()
        record['state']='ready'
        with self.assertRaises(ValueError):handle.launch()
        handle=owner.select();record['identity']='foreign'
        with self.assertRaises(ValueError):handle.launch()
        self.assertEqual(launched,[])

    def test_failed_refresh_quarantines_without_reissue_or_retry(self):
        record={'identity':'synthetic-selected','generation':1,'state':'ready'}
        def failed():raise RuntimeError('synthetic private details')
        owner=ManagedCodexOwner('synthetic-selected',lambda:dict(record),lambda:None,
                                supported_refresh=failed)
        old=owner.select()
        with self.assertRaisesRegex(ValueError,'^managed refresh unavailable$'):owner.refresh()
        with self.assertRaises(ValueError):old.launch()
        with self.assertRaises(ValueError):owner.select()
