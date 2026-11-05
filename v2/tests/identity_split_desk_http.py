"""Root-only complete synthetic Deep/native/Core/Root desk capability rehearsal.

No real provider, Vault, desktop, owner request, credential or deployment. The
production split gate remains closed; this qualifies a fresh Codex tool path.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0,str(Path(__file__).parent))
from identity_split_service_http import Rehearsal,ROOT,UID,GID,digest,process,exists,wait,Package
from codex_service.ownership import Adopted


class DeskRehearsal(Rehearsal):
    def __init__(self,binary,fault_anchor=False,stop_helper=False):
        self.fault_anchor=fault_anchor;self.stop_helper=stop_helper;self.anchor_fault_injected=False
        super().__init__(binary)
        subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror','-DORKESTR_TEST_DESK=1',
            '-DORKESTR_TEST_AUTHORITY_CORE='+json.dumps(str(self.package.data/'core.sqlite3')),
            str(ROOT/'v2/tests/selected_codex_roles_native.c'),'-o',str(self.package.root/'native')],check=True,capture_output=True,env={'PATH':'/usr/bin:/bin'})
        os.chown(self.package.root/'native',0,GID);(self.package.root/'native').chmod(0o550)
        self.refresh_manifest()

    def initialize_core(self):
        super().initialize_core()
        self.marker=self.fixture.root/'root-helper-proof.json'
        helper=self.fixture.root/'fixed-approved-helper'
        helper.write_text('''#!/usr/bin/python3
import json,os,subprocess,sys,time
from pathlib import Path
assert os.geteuid()==0
assert sys.argv[1:]==['--conversation',%r,'--desk','synthetic-desk','example.invalid']
assert set(os.environ)<=set(['PATH','LANG','PYTHONDONTWRITEBYTECODE','LC_CTYPE'])
p=subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-c','import os,time;os.fork();time.sleep(30)'],start_new_session=True)
marker=Path(%r);marker.write_text(json.dumps({'helper':os.getpid(),'helper_uid':os.geteuid(),'escaped':p.pid}));marker.chmod(0o600)
%s
'''%(self.conversation,str(self.marker),'time.sleep(30)' if self.fault_anchor or self.stop_helper else ''))
        helper.chmod(0o550)
        definition=self.fixture.root/'approved-desk-operations.json'
        definition.write_text(json.dumps({'format':'orkestr-desk-operations-v1','operations':{'synthetic-login':{
            'helper':str(helper),'sha256':digest(helper),'conversation_id':self.conversation,
            'desk':'synthetic-desk','site':'example.invalid','duration_ms':30000}}}))
        definition.chmod(0o440)
        service=self.package.root/'service.json';value=json.loads(service.read_text())
        value['desk_login']={'path':str(definition),'sha256':digest(definition)};service.write_text(json.dumps(value))
        self.refresh_manifest();self.package=Package(self.package.root,self.manifest)

    def run(self):
        if self.fault_anchor:return self.run_fault()
        if self.stop_helper:return self.run_stop()
        report=super().run()
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            row=db.execute('SELECT o.state,r.state,r.written_bytes,o.run_id FROM deep_desk_operations o JOIN deep_desk_results r ON r.operation_id=o.id').fetchall()
        assert len(row)==1 and row[0][0:2]==('helper_completed','delivered') and row[0][2]>0,row
        assert row[0][3]==report['core_run_id']
        records=[json.loads(path.read_text()) for path in (self.package.ledger_directory/'desk-operations').glob('*.json')]
        assert len(records)==1 and records[0]['state']=='helper_completed' and records[0]['cleanup'] is True,records
        assert not self.manager.desk.active
        trace=[json.loads(line) for line in (self.fixture.account/'sessions/synthetic-role.jsonl').read_text().splitlines()]
        assert sum(r['kind']=='desk-result' for r in trace)==1
        proof=json.loads(self.marker.read_text());assert proof['helper_uid']==0
        assert process(proof['helper']) is None and process(proof['escaped']) is None
        report.update(native_tool_result_delivered=True,core_operation_consumed_once=True,root_fixed_helper_uid=0,
                      actual_detached_tree_reaped=True,root_operation_cleanup=True,real_desktop=False,real_vault=False)
        return report

    def run_stop(self):
        self.initialize_core();self.start_rehearsal();path=f'/api/v2/conversations/{self.conversation}'
        status,admitted=self.request(path+'/messages','POST',{'client_message_id':'synthetic-desk-stop','text':'synthetic ordinary HTTP input 1','author':'owner'},{})
        assert status==202
        status,window=self.request(path+'/window','POST',{'request_key':'window:synthetic-desk-stop','input_message_id':admitted['message_id'],
            'input_event_id':admitted['event_id'],'input_request_key':'synthetic-desk-stop','expected_generation':0,'window_id':None,'predecessor_window_id':None},{})
        assert status==201,(status,window)
        wait(self.marker.exists,'actual Root helper ready')
        def stoppable():
            code,state=self.request(path+'/execution')
            return state if code==200 and state['phase']=='running' and state['capabilities']['stop'] else None
        state=wait(stoppable,'actual Deep Stop availability')
        status,reply=self.request(path+'/stop','POST',{'run_id':state['run_id'],'expected_revision':state['revision'],
            'expected_control_revision':state['control_revision'],'request_key':'stop:synthetic-desk'})
        assert status==200,(status,reply)
        def stopped():
            assert not self.pump_errors,self.pump_errors
            with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
                return db.execute("SELECT state FROM production_runs WHERE id=? AND state='cancelled'",(state['run_id'],)).fetchone()
        wait(stopped,'Root helper cleanup and native stop',seconds=15)
        wait(lambda:not self.manager.desk.active,'Root anchor reap')
        records=[json.loads(p.read_text()) for p in (self.package.ledger_directory/'desk-operations').glob('*.json')]
        assert len(records)==1 and records[0]['state']=='cancelled' and records[0]['cleanup'] is True,records
        proof=json.loads(self.marker.read_text());assert process(proof['helper']) is None and process(proof['escaped']) is None
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            assert db.execute('SELECT count(*) FROM deep_desk_results').fetchone()[0]==0
        trace=[json.loads(line) for line in (self.fixture.account/'sessions/synthetic-role.jsonl').read_text().splitlines()]
        assert not any(r['kind']=='desk-result' for r in trace) and any(r['kind']=='interrupt' for r in trace)
        return dict(owner_http_stop=True,root_helper_cancelled_and_reaped=True,native_run_cancelled=True,native_tool_success=False,
                    actual_provider=False,real_desktop=False,real_vault=False,live_activation=False)

    def start_rehearsal(self):
        super().start_rehearsal()
        if not self.fault_anchor:return
        tick=self.manager.tick
        def injected_tick():
            if not self.anchor_fault_injected and self.manager.desk and self.manager.desk.active and self.marker.exists():
                proof=json.loads(self.marker.read_text());helper=process(proof['helper']);escaped=process(proof['escaped'])
                grandchildren=[process(pid) for pid in Adopted.children(escaped)] if escaped else []
                grandchildren=[p for p in grandchildren if p and p['ppid']==escaped['pid']]
                if helper and escaped and grandchildren:
                    self.fault_originals=[helper,escaped,*grandchildren]
                    handle=next(iter(self.manager.desk.active.values()))
                    handle['child'].kill();handle['child'].wait(timeout=2)
                    self.anchor_fault_injected=True
            return tick()
        self.manager.tick=injected_tick

    def run_fault(self):
        self.initialize_core();self.start_rehearsal();path=f'/api/v2/conversations/{self.conversation}'
        status,admitted=self.request(path+'/messages','POST',{'client_message_id':'synthetic-desk-fault','text':'synthetic ordinary HTTP input 1','author':'owner'},{})
        assert status==202
        status,window=self.request(path+'/window','POST',{'request_key':'window:synthetic-desk-fault','input_message_id':admitted['message_id'],
            'input_event_id':admitted['event_id'],'input_request_key':'synthetic-desk-fault','expected_generation':0,'window_id':None,'predecessor_window_id':None},{})
        assert status==201,(status,window)
        wait(lambda:self.anchor_fault_injected and self.manager.custody_fault and self.manager.adopted and self.manager.adopted.records and
             all(record.gone() for record in self.manager.adopted.records.values()),'actual Root orphan cleanup',seconds=15)
        assert len(self.fault_originals)>=3 and all(not exists(p) for p in self.fault_originals)
        records=[json.loads(p.read_text()) for p in (self.package.ledger_directory/'desk-operations').glob('*.json')]
        assert len(records)==1 and records[0]['state']=='unknown' and not records[0]['cleanup'],records
        states=[self.manager.ledger.details(w.window,w.generation) for w in self.manager.windows.values()]
        assert states and all(s['state']=='reconciliation' for s in states),states
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            assert db.execute("SELECT count(*) FROM production_runs WHERE state='succeeded'").fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM deep_desk_results').fetchone()[0]==0
            assert db.execute("SELECT count(*) FROM deep_desk_operations WHERE state='delivery_unknown'").fetchone()[0]==1
        self.fault_orphan=True;self.fault_qualified=True
        return dict(fault_injected=True,actual_root_orphans=len(self.fault_originals),global_reaped=True,manager_recovered=False,
            physical_cleanup_only=True,unknown_operation_fenced=True,native_tool_success=False,actual_provider=False,live_activation=False)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('binary');parser.add_argument('--report',required=True)
    parser.add_argument('--fault-anchor',action='store_true')
    parser.add_argument('--stop-helper',action='store_true')
    args=parser.parse_args();assert os.geteuid()==0
    assert not(args.fault_anchor and args.stop_helper)
    os.umask(0o077);case=DeskRehearsal(args.binary,args.fault_anchor,args.stop_helper);report={'passed':False,'live_activation':False}
    try:report.update(case.run(),passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__,error=str(error),manager_errors=case.pump_errors)
        if case.process and case.process.stderr:
            os.set_blocking(case.process.stderr.fileno(),False)
            try:report['synthetic_server_stderr']=os.read(case.process.stderr.fileno(),8192).decode(errors='replace')
            except BlockingIOError:pass
        raise
    finally:
        try:case.close();report['cleanup_completed']=True
        except BaseException as error:report.update(passed=False,cleanup_error=type(error).__name__+': '+str(error));raise
        finally:
            fd=os.open(args.report,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
            with os.fdopen(fd,'w') as stream:json.dump(report,stream,indent=2)
    print('synthetic Deep desk capability flow passed')


if __name__=='__main__':main()
