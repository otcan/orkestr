"""Explicit Root-only actual Core restart, queued input and natural timer hold.

Disposable synthetic service/native fixtures only; no live credentials or sends.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from identity_split_service_http import Rehearsal, wait


class MaintenanceRehearsal(Rehearsal):
    def __init__(self, binary, expected_source):
        super().__init__(binary)
        self.expected_source=expected_source

    def read(self, query, parameters=()):
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            return db.execute(query,parameters).fetchall()

    def stop_instance(self):
        self.pump_stop.set()
        self.pump.join(timeout=3)
        assert not self.pump.is_alive()
        assert self.manager.close(), 'ordinary managed shutdown custody failed'
        self.process.stderr.close()
        self.manager=None
        self.process=None
        self.pump_stop=threading.Event()

    def run_maintenance(self):
        self.initialize_core()
        marker=self.fixture.root/'operator-maintenance'
        marker.write_text('synthetic owner publication in progress\n')
        marker.chmod(0o600)
        beta=self.package.root/'beta.json'
        value=json.loads(beta.read_text())
        value['deploy_maintenance_marker']=str(marker)
        beta.write_text(json.dumps(value))
        token=self.fixture.root/'timer-token'
        token.write_text(self.token)
        token.chmod(0o600)
        os.chown(token,self.package.authority_uid,self.gid)
        timer=self.fixture.root/'timer-config'
        timer.write_text(json.dumps({'schema_version':1,'machine_token_file':str(token)}))
        timer.chmod(0o600)
        os.chown(timer,self.package.authority_uid,self.gid)
        service=self.package.root/'service.json'
        value=json.loads(service.read_text())
        value['timer_config']=str(timer)
        service.write_text(json.dumps(value))
        self.refresh_manifest()
        self.start_rehearsal()
        first_pid=self.process.pid
        path=f'/api/v2/conversations/{self.conversation}'
        status,receipt=self.request(path+'/messages','POST',{
            'client_message_id':'synthetic-maintenance-input','text':'synthetic ordinary HTTP input 1','author':'owner'})
        assert status==202,(status,receipt)
        intent={'request_key':'synthetic-maintenance-window','input_message_id':receipt['message_id'],
                'input_event_id':receipt['event_id'],'input_request_key':'synthetic-maintenance-input',
                'expected_generation':0,'window_id':None,'predecessor_window_id':None}
        status,queued=self.request(path+'/window','POST',intent)
        assert status==202,(status,queued)
        import uuid
        namespace=str(uuid.uuid4())
        status,imported=self.request('/api/v2/timers/import','POST',{
            'namespace':namespace,'source_namespace':'synthetic-maintenance','source_timer_id':'due-once',
            'source_enabled':True,'schedule':{'kind':'once','due_ms':int(time.time()*1000)+1500},
            'conversation_id':self.conversation,'label':'Synthetic held timer','source_thread_id':'synthetic-thread'})
        assert status==200,(status,imported)
        status,enabled=self.request('/api/v2/timers/'+namespace+'/enable','POST',{
            'expected_revision':1,'request_key':'synthetic-maintenance-enable',
            'conversation_id':self.conversation,'text':'synthetic ordinary HTTP input 2'})
        assert status==200,(status,enabled)
        def held():
            time.sleep(2)
            assert not self.pump_errors,self.pump_errors
            assert self.read('SELECT count(*) FROM production_runs')==[(0,)]
            assert self.read('SELECT count(*) FROM execution_windows')==[(0,)]
            assert self.read('SELECT count(*) FROM dormant_timer_inputs')==[(0,)]
            assert self.read("SELECT count(*) FROM execution_window_queue WHERE state='queued'")==[(1,)]
            assert marker.exists()
        held()
        self.stop_instance()
        # Legacy startup cleanup is deliberately exercised beside the persistent
        # Root marker: it must not resume either queued work or the due timer.
        (self.package.data/'deploy-drain.request').write_text('stale process drain\n')
        self.start_rehearsal()
        assert self.process.pid!=first_pid
        assert not (self.package.data/'deploy-drain.request').exists()
        assert self.request(path+'/window','POST',intent)[0]==202
        held()
        marker.unlink()  # Root publication point; Core cannot unlink this file.
        def accepted():
            assert not self.pump_errors,self.pump_errors
            rows=self.read("SELECT id FROM production_runs WHERE message_id=? AND role='deep' AND state='succeeded'",(receipt['message_id'],))
            return rows[0] if rows else None
        run=wait(accepted,'held HTTP input executes only after Root publication',seconds=35)
        wait(lambda:self.read('SELECT count(*) FROM dormant_timer_inputs')==[(1,)],
             'due timer fires exactly once after Root publication',seconds=15)
        timer_run=wait(lambda:self.read("SELECT r.id FROM production_runs r JOIN dormant_timer_inputs i ON i.message_id=r.message_id WHERE r.role='deep' AND r.state='succeeded'"),
                       'deferred timer provider result accepted before cleanup',seconds=35)
        source=self.request('/api/v2/health')[1]['build']['source_commit']
        assert source==self.expected_source, 'exact source-stamped server required'
        return {'passed':True,'actual_http_restart':True,'root_hold_survived_restart':True,
                'queued_input_run':run[0],'natural_due_timer_fires':1,'timer_run':timer_run[0][0],'actual_provider':False,
                'live_activation':False,'source':source}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary');parser.add_argument('--report',required=True)
    parser.add_argument('--source-commit',required=True)
    args=parser.parse_args()
    assert len(args.source_commit)==40 and all(c in "0123456789abcdef" for c in args.source_commit)
    case=MaintenanceRehearsal(args.binary,args.source_commit)
    report={'passed':False}
    try:
        report=case.run_maintenance()
    except BaseException as error:
        report['error']=type(error).__name__+': '+str(error)
        for key,query in {
            'windows':'SELECT generation,state FROM execution_windows',
            'runs':'SELECT role,state,dispatch_state FROM production_runs',
            'inbox':'SELECT state,claim_generation FROM reasoning_inbox',
            'queue':'SELECT state,withdrawal FROM execution_window_queue',
            'timers':'SELECT count(*) FROM dormant_timer_inputs',
            'observations':'SELECT kind,receipt_state FROM production_observations',
        }.items():
            try:report[key]=case.read(query)
            except sqlite3.Error:pass
        report['native_claims']=[json.loads(p.read_text()) for p in (case.package.ledger_directory/'launches').glob('*.json')]
        trace=case.fixture.account/'sessions/synthetic-role.jsonl'
        if trace.exists():report['native_trace']=trace.read_text()[-8192:]
        status=case.package.data/'deploy-drain.status.json'
        if status.exists():report['drain']=json.loads(status.read_text())
        if case.process and case.process.stderr:
            os.set_blocking(case.process.stderr.fileno(),False)
            try:report['synthetic_stderr']=os.read(case.process.stderr.fileno(),16384).decode(errors='replace')
            except BlockingIOError:pass
        raise
    finally:
        try:
            case.close()
            report['cleanup_completed']=True
        except BaseException as error:
            report['passed']=False
            report['cleanup_error']=type(error).__name__+': '+str(error)
            raise
        finally:
            fd=os.open(args.report,os.O_CREAT|os.O_WRONLY|os.O_TRUNC,0o600)
            with os.fdopen(fd,'w') as stream:json.dump(report,stream,indent=2)
    print('synthetic maintenance restart/queued input/natural timer passed')

if __name__=='__main__':main()
