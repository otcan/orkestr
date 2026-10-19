"""Independent final-state and delayed-entry regressions; synthetic children only."""
import pathlib,sys,subprocess,threading,time,os,shlex,unittest
from types import SimpleNamespace
from test_codex_service_ledger import LedgerTests,uid
from codex_service.contract import Refused
from codex_service.ownership import Children
from codex_bounded.trust import process

class FinalStateTests(LedgerTests):
    def late_join(self,request):
        join={**request,'request_id':uid(),'input_message_id':uid(),'input_event_id':uid(),'input_request_key':'synthetic-late-input','expected_generation':1}
        with self.assertRaises(Refused):self.ledger.admit(join)
    def test_late_join_cannot_replace_sticky_reconciliation(self):
        request=self.admit()
        self.ledger.uncertain(request['window_id'],1,'cleanup_unknown')
        before=self.ledger.status()
        self.clock.advance(901)
        self.late_join(request)
        self.assertEqual(self.ledger.status(),before)
        with self.assertRaises(Refused):self.ledger.retire(self.retirement(request))
    def test_late_join_cannot_rewrite_retired_history(self):
        request=self.admit();self.ledger.retire(self.retirement(request));before=self.ledger.status()
        self.clock.advance(901);self.late_join(request)
        self.assertEqual(self.ledger.status(),before)

class PausedLaunchTests(unittest.TestCase):
    def test_valid_delayed_wrapper_is_bound_at_its_final_pause(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix='synthetic-delayed-broker-') as name:
            root=pathlib.Path(name);(root/'codex_service').mkdir()
            entry=root/'codex_service/entry.py'
            entry.write_text('import os,signal,time\nos.kill(os.getpid(),signal.SIGSTOP)\ntime.sleep(0.02)\n')
            argv=[str(pathlib.Path('/usr/bin/python3').resolve()),'-I','-S','-B',str(entry),'broker','open-owned-session','--protocol','orkestr-v2-provider-broker-v1']
            command='read ready; exec '+shlex.join(argv)
            child=subprocess.Popen(['/bin/sh','-c',command],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin'})
            owned=Children(SimpleNamespace(root=root,uid=os.getuid()),process(os.getpid()))
            def release():
                try:child.stdin.write(b'go\n');child.stdin.flush()
                except (OSError,ValueError):pass
            timer=threading.Timer(0.1,release);timer.start()
            try:
                identity=process(child.pid)
                self.assertTrue(owned.bind(child.pid,identity['start'],time.monotonic()+2))
                child.wait(3)
                self.assertTrue(owned.proven_gone())
            finally:
                timer.cancel();timer.join()
                if child.poll() is None:child.kill()
                child.wait(3);child.stdin.close();owned.close()
                self.assertIsNone(process(child.pid))

def load_tests(loader,_tests,_pattern):
    suite=unittest.TestSuite()
    for name in ['test_late_join_cannot_replace_sticky_reconciliation','test_late_join_cannot_rewrite_retired_history']:
        suite.addTest(FinalStateTests(name))
    suite.addTests(loader.loadTestsFromTestCase(PausedLaunchTests));return suite
if __name__=='__main__':unittest.main()
