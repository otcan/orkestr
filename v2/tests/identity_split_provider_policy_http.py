"""Opt-in actual Root/Core/native policy handoff, synthetic providers only.

Requires root and a separately built source-stamped server binary. Disposable
numeric UIDs, closed fixture manifests and loopback listeners; no live rollout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parent))
from identity_split_service_http import Rehearsal,wait
from codex_service.qualification import code_subject


class PolicyRehearsal(Rehearsal):
    def __init__(self,binary,minimal=False,debug_broker=False,idle=False):
        super().__init__(binary,provider='claude')
        try:
            if not minimal:
                self.configure_roles()
                (self.fixture.workspace/'mode').write_text('complete')
            if debug_broker:
                path=self.package.root/'codex_service/broker.py';source=path.read_text()
                diagnostic='\n'.join(['    except Exception as diagnostic:', '        import re', '        reason=str(diagnostic)', "        reason=reason if re.fullmatch('[a-z_]{1,80}',reason) else 'nonliteral_refusal'", "        sys.stderr.write('SYNTHETIC_CHILD_EXIT='+str(getattr(getattr(pump,'child',None),'returncode',None))+'\\n')", '        frames=[];trace=diagnostic.__traceback__', '        while trace and len(frames)<10:', "            frames.append((trace.tb_frame.f_code.co_filename.rsplit('/',1)[-1],trace.tb_lineno));trace=trace.tb_next", "        sys.stderr.write('SYNTHETIC ONLY diagnostic: '+type(diagnostic).__name__+':'+reason+':'+str(getattr(diagnostic,'errno',0))+':'+str(frames)+'\\n')"])+'\n'
                anchor='    except Exception:\n        sys.stderr.write(\"selected Codex service broker refused'
                assert source.count(anchor)==1
                changed=source.replace(anchor,diagnostic+'        sys.stderr.write(\"selected Codex service broker refused')
                compile(changed,'synthetic_diagnostic_broker','exec')
                path.write_text(changed)
            self.debug_broker=debug_broker
            self.idle=idle
            self.broker_diagnostics=self.fixture.root/'synthetic-broker-diagnostics'
            self.broker_log=self.broker_diagnostics.open('ab')
            path=self.fixture.package/'beta.json';beta=json.loads(path.read_text())
            beta['provider_routing']={'allow_native_handoff':True,'rules':[{
                'id':'synthetic-category','terms':[{'text':'cedar','weight':3}],
                'threshold':3,'excluded':'claude','preferred':'codex'}]}
            path.write_text(json.dumps(beta));self.refresh_manifest()
        except BaseException:
            self.fixture.close()
            raise

    def read(self,query,bindings=()):
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            return db.execute(query,bindings).fetchall()

    def failure_snapshot(self):
        result={}
        queries={
            'windows':'SELECT generation,state FROM execution_windows LIMIT 16',
            'runs':'SELECT role,state,dispatch_state FROM production_runs LIMIT 16',
            'bindings':'SELECT role,state,provider_kind,generation FROM session_bindings LIMIT 16',
            'inbox':'SELECT state,claim_generation,admitted_run_id IS NOT NULL FROM reasoning_inbox LIMIT 16',
            'queue':'SELECT state,withdrawal FROM execution_window_queue LIMIT 16',
            'handoffs':'SELECT from_provider,to_provider,provider_generation FROM conversation_provider_handoffs LIMIT 16',
        }
        for key,query in queries.items():
            try:result[key]=self.read(query)
            except sqlite3.Error as error:result[key]=type(error).__name__
        if self.process and self.process.stderr:
            os.set_blocking(self.process.stderr.fileno(),False)
            try:result['diagnostic_stderr']=os.read(self.process.stderr.fileno(),16384).decode(errors='replace')
            except BlockingIOError:pass
        result['managed_broker_exit_codes']=[handle.child.poll() for handle in self.manager.launcher.children.values()] if self.manager and self.manager.launcher else []
        for label,path in [('codex',self.fixture.account/'sessions/synthetic-role.jsonl'),('broker',self.broker_diagnostics)]:
            if path.exists():
                if label=='codex':result['codex_events']=[json.loads(line).get('kind') for line in path.read_text().splitlines()]
                else:result['synthetic_broker_stderr']=path.read_text()[-8192:]
        return result

    def run(self):
        import subprocess
        from unittest.mock import patch
        original=subprocess.Popen
        def observed(command,*args,**kwargs):
            if type(command) is list and len(command)>5 and command[5]=='launch-child':
                kwargs['stderr']=self.broker_log
            return original(command,*args,**kwargs)
        # Only the closed synthetic child stderr changes; every custody/FD,
        # executable, argv, privilege and package fence is unchanged.
        with patch('codex_service.launch.subprocess.Popen',side_effect=observed):
            return self.run_policy()

    def run_policy(self):
        initial=super().run()
        status,health=self.request('/api/v2/health')
        source=health.get('build',{}).get('source_commit')
        assert status==200 and source==self.expected_source,'qualified source changed'
        path=f'/api/v2/conversations/{self.conversation}'
        before=self.read("SELECT id,generation FROM execution_windows WHERE conversation_id=? ORDER BY generation DESC LIMIT 1",(self.conversation,))[0]
        initial_epoch=self.read('SELECT provider_generation FROM conversation_settings WHERE conversation_id=?',(self.conversation,))[0][0]
        trace=self.fixture.root/'claude-workspace/claude-peer.jsonl'
        old_turns=sum(json.loads(line)['kind']=='turn' for line in trace.read_text().splitlines())
        if not self.idle:
            drain=self.package.data/'deploy-drain.request';drain.write_text('synthetic fixture drain\n')
            def closed():
                assert not self.pump_errors,self.pump_errors
                rows=self.read('SELECT state FROM execution_windows WHERE id=?',(before[0],))
                return rows and rows[0][0]=='closed'
            wait(closed,'old accepted window custody closes',seconds=35)
            drain.unlink()
            def resumed():
                value=json.loads((self.package.data/'deploy-drain.status.json').read_text())
                return not value['draining']
            wait(resumed,'supported admission resume',seconds=5)
        message='Synthetic cedar continuation after a retired Claude window'
        status,receipt=self.request(path+'/messages','POST',{'client_message_id':'synthetic-policy-current','text':message,'author':'owner'})
        assert status==202,(status,receipt)
        body={'request_key':'window:synthetic-policy-current','input_message_id':receipt['message_id'],
              'input_event_id':receipt['event_id'],'input_request_key':'synthetic-policy-current',
              'expected_generation':before[1],'window_id':before[0] if self.idle else None,'predecessor_window_id':None if self.idle else before[0]}
        status,window=self.request(path+'/window','POST',body)
        assert status in (201,202),(status,window)
        def accepted():
            assert not self.pump_errors,self.pump_errors
            rows=self.read("SELECT r.id,r.native_session_id,b.provider_kind,b.id FROM production_runs r JOIN session_bindings b ON b.id=r.session_id WHERE r.message_id=? AND r.role='deep' AND r.state='succeeded'",(receipt['message_id'],))
            state=self.read('SELECT state FROM execution_windows ORDER BY generation DESC LIMIT 1')
            assert not (not rows and state==[('reconciliation_required',)]),'fresh native setup requires reconciliation'
            return rows[0] if rows else None
        result=wait(accepted,'new current input completes on fresh Codex lineage',seconds=35)
        assert result[2]=='codex' and result[1]!=initial['native_session_id']
        history=self.read("SELECT d.turn_text FROM conversation_handoff_context_delivery d JOIN production_runs r ON r.id=d.run_id WHERE r.message_id=? AND r.role='deep'",(receipt['message_id'],))
        assert len(history)==1 and 'a standing operator provider policy' in history[0][0]
        assert '<historical_context>' in history[0][0] and 'Current input:\n'+message in history[0][0]
        assert self.read("SELECT count(*) FROM production_runs WHERE message_id=? AND role='deep'",(receipt['message_id'],))==[(1,)]
        assert self.read("SELECT count(*) FROM production_runs r JOIN messages m ON m.id=r.message_id WHERE m.request_key='synthetic-split-first' AND r.role='deep'")==[(1,)],'old input replayed'
        assert self.read("SELECT count(*) FROM operator_provider_handoffs WHERE source_message_id=? AND source_commit=?",(receipt['message_id'],source))==[(1,)]
        assert self.read("SELECT provider,provider_generation FROM conversation_settings WHERE conversation_id=?",(self.conversation,))==[('codex',initial_epoch+1)]
        assert sum(json.loads(line)['kind']=='turn' for line in trace.read_text().splitlines())==old_turns,'forbidden input reached Claude'
        assert all(message not in json.loads(line).get('text','') for line in trace.read_text().splitlines())
        codex_trace=self.fixture.account/'sessions/synthetic-role.jsonl'
        records=[json.loads(line) for line in codex_trace.read_text().splitlines()]
        assert any(record.get('kind')=='turn' for record in records)
        status,replay=self.request(path+'/window','POST',body)
        assert status in (200,201,202),(status,replay)
        assert self.read("SELECT count(*) FROM production_runs WHERE message_id=? AND role='deep'",(receipt['message_id'],))==[(1,)]
        from workflow_measured_evidence import routing
        measured=routing(self,source,receipt,initial_epoch,old_turns,initial,result[0],message)
        return dict(routing_evidence=measured,code_subject=code_subject(self.package),server_identity=self.server_identity,
                    server_sha256=self.server_sha256,source_commit=source,binary_sha256=hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                    harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),manifest_sha256=self.manifest,authority_uid=self.package.authority_uid,executor_uid=self.uid,
                    old_claude_turns=old_turns,new_current_deep_runs=1,provider_generation=initial_epoch+1,
                    original_input_replayed=False,forbidden_claude_turns=0,operator_handoff_receipts=1,
                    automatic_idle_retirement=self.idle,diagnostic_broker=self.debug_broker,quoted_history_delivered=True,scoped_root_launch=True,actual_http=True,actual_provider=False,live_activation=False)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('binary');parser.add_argument('--report',required=True)
    parser.add_argument('--expected-source',required=True,help='reviewed full Git commit embedded in this server artifact')
    parser.add_argument('--minimal-profile',action='store_true')
    parser.add_argument('--idle-handoff',action='store_true',help='policy retires the already accepted window without deploy drain')
    parser.add_argument('--debug-broker',action='store_true',help='diagnostic fixture only; never qualification')
    args=parser.parse_args();assert os.geteuid()==0,'root-only synthetic fixture'
    import resource,re,subprocess
    assert re.fullmatch('[0-9a-f]{40}',args.expected_source),'invalid expected source'
    version=subprocess.run([args.binary,'--version','--json'],check=True,capture_output=True,text=True,env={'PATH':'/usr/bin:/bin'})
    version=json.loads(version.stdout)
    assert version.get('component')=='server' and version.get('source_commit')==args.expected_source,'binary source mismatch'
    from isolation.authenticated_budget import AUTHENTICATED
    hard=resource.getrlimit(resource.RLIMIT_AS)[1]
    assert hard==resource.RLIM_INFINITY or hard>=AUTHENTICATED.address_bytes,'inherited virtual limit conflicts with declared native budget'
    resource.setrlimit(resource.RLIMIT_AS,(AUTHENTICATED.address_bytes,AUTHENTICATED.address_bytes))
    case=PolicyRehearsal(args.binary,args.minimal_profile,args.debug_broker,args.idle_handoff)
    case.expected_source=args.expected_source
    try:result=case.run()
    except BaseException:
        Path(args.report).write_text(json.dumps(dict(ok=False,snapshot=case.failure_snapshot()),indent=2)+"\n")
        raise
    finally:
        try:case.close()
        finally:case.broker_log.close()
    Path(args.report).write_text(json.dumps(result,indent=2)+'\n')
    print('Synthetic Root/Core provider policy handoff passed; no provider API or live activation')

if __name__=='__main__':main()
