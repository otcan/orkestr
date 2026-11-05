"""Owner HTTP Stop after a renewed original-native MCP helper lease."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parent))
from identity_split_managed_mcp_http import ManagedRehearsal
from identity_split_service_http import wait,process


class StopRehearsal(ManagedRehearsal):
    def run(self):
        self.initialize_core();self.start_rehearsal();path='/api/v2/conversations/'+self.conversation
        if self.provider=='claude':
            code,value=self.request(path+'/settings','PUT',dict(expected_revision=0,provider='claude',
                model='synthetic-claude-model',reasoning_effort='low',honor_no_reply=True,review_before_accepting=False))
            assert code==200,(code,value)
        code,receipt=self.request(path+'/messages','POST',dict(client_message_id='synthetic-managed-stop',
            text='synthetic ordinary HTTP input 1',author='owner'))
        assert code==202,(code,receipt)
        code,window=self.request(path+'/window','POST',dict(request_key='window:synthetic-managed-stop',
            input_message_id=receipt['message_id'],input_event_id=receipt['event_id'],
            input_request_key='synthetic-managed-stop',expected_generation=0,window_id=None,predecessor_window_id=None))
        assert code==201,(code,window)
        def renewed():
            assert not self.pump_errors,self.pump_errors
            for file in (self.package.ledger_directory/'managed-requests').glob('*.json'):
                row=json.loads(file.read_text())
                if row['request']['operation']=='desk_login' and row.get('latest_capability',{}).get('lease_generation',0)>1:return row
        operation=wait(renewed,'actual same-operation lease renewal before Stop',seconds=40)
        helpers=[json.loads(line) for line in self.marker.read_text().splitlines()]
        assert len(helpers)==1 and process(helpers[0]['helper']) is not None
        code,state=self.request(path+'/execution');assert code==200 and state['capabilities']['stop'],state
        before=time.monotonic()
        code,reply=self.request(path+'/stop','POST',dict(run_id=state['run_id'],expected_revision=state['revision'],
            expected_control_revision=state['control_revision'],request_key='stop:synthetic-managed'))
        assert code==200,(code,reply)
        def stopped():
            assert not self.pump_errors,self.pump_errors
            rows=self.rows('SELECT state FROM production_runs WHERE id=?',(state['run_id'],))
            return rows and rows[0]['state']=='cancelled'
        wait(stopped,'Core owner Stop and exact native cancellation',seconds=15)
        wait(lambda:not self.manager.desk.active,'actual Root original helper/anchor reap',seconds=10)
        assert process(helpers[0]['helper']) is None
        record=json.loads((self.package.ledger_directory/'desk-operations'/(operation['request_id']+'.json')).read_text())
        assert record['state']=='cancelled' and record['cleanup'] is True,record
        trace=(self.trace_path if self.provider=='claude' else self.fixture.account/'sessions/synthetic-role.jsonl')
        events=[json.loads(line) for line in trace.read_text().splitlines()]
        assert any(r['kind']=='interrupt' for r in events) and not any(r['kind']=='desk-result' for r in events),events
        rows=self.rows('SELECT state FROM managed_operations WHERE id=?',(operation['request_id'],))
        assert rows==[{'state':'delivery_unknown'}],rows
        return dict(provider=self.provider,owner_http_stop=True,stop_elapsed_ms=int((time.monotonic()-before)*1000),
            exact_original_helper_renewed=True,one_helper_only=True,root_helper_cancelled_and_reaped=True,
            native_exact_interrupt=True,native_tool_success=False,unknown_core_effect_not_replayed=True,
            actual_provider=False,real_desktop=False,real_vault=False,live_activation=False)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('binary');parser.add_argument('--report',required=True)
    parser.add_argument('--provider',choices=('codex','claude'),default='codex');args=parser.parse_args()
    assert os.geteuid()==0;os.umask(0o077);case=StopRehearsal(args.binary,args.provider,120)
    report={'passed':False,'live_activation':False}
    try:report.update(case.run(),passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__,error=str(error),manager_errors=case.pump_errors)
        report['synthetic_root_records']={name:[json.loads(p.read_text()) for p in
            (case.package.ledger_directory/name).glob('*.json')]
            for name in ('launches','managed-requests','native-registrations','desk-operations')}
        report['synthetic_runs']=case.rows('SELECT id,state,role FROM production_runs')
        trace=case.trace_path if args.provider=='claude' else case.fixture.account/'sessions/synthetic-role.jsonl'
        report['synthetic_trace']=trace.read_text() if trace.exists() else None
        if case.process and case.process.stderr:
            os.set_blocking(case.process.stderr.fileno(),False)
            try:report['synthetic_server_stderr']=os.read(case.process.stderr.fileno(),8192).decode(errors='replace')
            except BlockingIOError:pass
        raise
    finally:
        try:case.close();report['cleanup_completed']=True
        finally:
            fd=os.open(args.report,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
            with os.fdopen(fd,'w') as stream:json.dump(report,stream,indent=2)
    print('synthetic managed MCP owner Stop passed')


if __name__=='__main__':main()
