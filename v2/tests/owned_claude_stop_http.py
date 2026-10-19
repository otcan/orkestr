"""Ordinary authenticated Claude Stop with a fixed synthetic native executable."""
from pathlib import Path
import shutil
import sys
import owned_claude_lifecycle_http as lifecycle
import owned_execution_http as ordinary


class StopCase(lifecycle.LifecycleCase):
    def configure(self, mode):
        super().configure(mode)
        shutil.copyfile(Path(__file__).with_name('owned_claude_stop_peer.py'),self.root/'synthetic-provider')

    def held(self):
        code,value,_ = self.request(self.path+'/held-inputs')
        assert code==200
        return value


def frozen(case):
    result = case.request(case.path+'/execution')[1]
    result.pop('observed_at_ms',None)
    return result


def exercise(mode):
    case=StopCase()
    try:
        case.setup(); case.stop(); case.configure(mode); case.start(configured=True)
        ordinary.wait_for(case.native_ready,'unobserved setup identity')
        assert case.message()[0]==202
        first=case.live(1)
        first=ordinary.wait_for(lambda: (s if (s:=case.phase('running')) and s['capabilities']['stop'] else None),
                                'exact live native must expose Stop')
        assert first['capabilities']=={'stop':True,'steer':False}
        assert case.begun(1)['input_uuid']==case.rows('SELECT message_id FROM production_runs')[0][0]
        assert case.message(2)[0]==202
        intent={'run_id':first['run_id'],'expected_revision':first['revision'],
                'expected_control_revision':first['control_revision'],'request_key':'claude-owner-stop'}
        before=case.rows('SELECT count(*) FROM production_cancellations')
        assert case.request(case.path+'/stop','POST',intent,extra={'x-orkestr-csrf':'foreign'})[0]==403
        assert case.request(case.path+'/stop','POST',intent,extra={'Origin':'http://foreign.invalid'})[0]==403
        assert case.request(case.path+'/stop','POST',dict(intent,provider='claude'))[0]==400
        assert case.request(case.path+'/stop','POST',dict(intent,expected_control_revision=first['control_revision']+1))[0]==409
        assert case.request(case.path+'/stop','POST',dict(intent,expected_revision=2**63-1))[0]==409
        assert case.rows('SELECT count(*) FROM production_cancellations')==before
        sampled=case.phase('running')
        (case.workspace/'advance-progress').touch()
        advanced=ordinary.wait_for(lambda: (s if (s:=case.phase('running')) and s['revision']>sampled['revision'] else None),
                                   'genuine progress after original control snapshot')
        assert advanced['control_revision']==first['control_revision']
        code,receipt,_=case.request(case.path+'/stop','POST',intent)
        assert code==200
        # The exact original request replays; it never redispatches an interrupt.
        assert case.request(case.path+'/stop','POST',intent)[:2]==(200,receipt)
        ordinary.wait_for(lambda:any(r['kind']=='interrupt' for r in case.trace()),'actual sole-writer interrupt')
        assert case.phase('cancel_requested') is not None
        assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'")==[(0,)]
        held=case.held()
        assert len(held['held'])==1 and held['held'][0]['boundary_run_id']==first['run_id']
        assert held['held'][0]['reason']=='stop_boundary' and not held['eligible_input_available']
        if mode in ('ack-only','revoke-after-ack'):
            ordinary.wait_for(lambda:any(r['kind']=='interrupt-ack' for r in case.trace()),'native ACK')
            assert not case.peer_gone()
            if mode=='revoke-after-ack':
                case.revoke_machine()
            else:
                # Allow the bounded observer to expire itself, without treating
                # ACK or local cleanup as an interrupted terminal.
                pass
            ordinary.wait_for(case.peer_gone,'unconfirmed control cleanup',seconds=13)
            assert case.phase('cancel_requested') is not None
            assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'")==[(0,)]
            return
        case.release('terminal',1)
        if mode=='foreign':
            ordinary.wait_for(case.peer_gone,'foreign terminal cleanup')
            assert case.phase('cancel_requested') is not None
            assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'")==[(0,)]
            return
        stopped=ordinary.wait_for(lambda:case.phase('cancelled'),'terminal plus original-tree reap')
        assert case.old_gone(1), 'durable Cancelled must follow original native-tree cleanup'
        assert stopped['capabilities']=={'stop':False,'steer':False}
        assert case.held()['held']==held['held']
        assert len([r for r in case.trace() if r['kind']=='interrupt'])==1
        assert case.rows('SELECT count(*) FROM production_runs')==[(1,)]
        assert case.message(3)[0]==202
        second=case.live(2)
        assert second['run_id']!=first['run_id'] and case.old_gone(1)
        assert case.begun(2)['resumed'] and case.begun(2)['native']==case.begun(1)['native']
        assert case.begun(2)['input_uuid']!=held['held'][0]['message_id']
        ordinary.wait_for(lambda:case.rows("SELECT count(*) FROM production_observations WHERE kind='progress' AND run_id=(SELECT id FROM production_runs ORDER BY scope_sequence DESC LIMIT 1)")==[(2,)],
                          'all bounded successor progress committed before replay snapshot')
        before=frozen(case)
        assert case.request(case.path+'/stop','POST',intent)[:2]==(200,receipt)
        assert frozen(case)==before
        case.accept(case.propose(2),2)
        ordinary.wait_for(case.peer_gone,'accepted successor cleanup')
        assert case.held()['held']==held['held']
        assert case.rows('SELECT count(*) FROM production_cancellations')==[(1,)]
        assert len([r for r in case.trace() if r['kind']=='turn'])==2
    finally:
        case.cleanup()


if __name__=='__main__':
    modes=sys.argv[2:] or ['success','terminal-first','burst','ack-only','foreign','revoke-after-ack']
    for mode in modes:
        exercise(mode)
        print('ordinary synthetic Claude Stop HTTP passed:',mode)
