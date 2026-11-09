"""Real Core/Root/Native Worker MCP across fresh and resumed primary turns.

Disposable synthetic native only: no live configuration, model, account or SDK.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

from identity_split_host_http import HostRehearsal
from identity_split_service_http import ROOT,GID,Rehearsal,wait
from codex_bounded.trust import digest
from codex_service.qualification import code_subject


def native_source(auth,account):
    source=(ROOT/'v2/tests/service_roles_native.c').read_text()
    begin=source.index('    if (argc != 6');end=source.index('    char auth[128];',begin)
    source=source[:begin]+'''    if (argc == 6) mcp_configuration(argc,argv);
    else if (argc != 4 || strcmp(argv[1],"app-server") || strcmp(argv[2],"--listen") || strcmp(argv[3],"stdio://")) return failure(20);
    if (prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1) return failure(21);
'''+source[end:]
    begin=source.index('    int fd = open("/account/auth.json", O_WRONLY);')
    end=source.index('    read_fixed("role"',begin);source=source[:begin]+source[end:]
    source=source.replace('#include <errno.h>','#include <errno.h>\n#include <sys/prctl.h>')
    source=source.replace('/account/auth.json',str(auth)).replace('/account',str(account))
    source=source.replace('readOnly','dangerFullAccess')
    source=source.replace('int main(int argc, char **argv) {',
        '#include '+json.dumps(str(ROOT/'v2/tests/native_worker_mcp.h'))+'\nint main(int argc, char **argv) {')
    source=source.replace('            char mode[32];',
        '            if (!strcmp(role,"deep")) native_worker_turn(input);\n            char mode[32];')
    return source


class NativeWorkerRehearsal(HostRehearsal):
    def __init__(self,binary,expected_source):
        super().__init__(binary,'codex')
        assert self.server_identity['source_commit']==expected_source,'exact source-stamped candidate required'
        self.configure_roles();(self.fixture.workspace/'mode').write_text('complete')
        beta=self.package.root/'beta.json';value=json.loads(beta.read_text());value.pop('legacy_companions',None)
        beta.write_text(json.dumps(value))
        service=self.package.root/'service.json';value=json.loads(service.read_text())
        value.update(managed_operations=True,managed_workers=True,managed_worker_execution_budget_ms=300000)
        service.write_text(json.dumps(value));self.refresh_manifest()

    def configure_host_native(self):
        source=native_source(self.fixture.auth,self.fixture.account)
        path=self.fixture.root/'synthetic-native-workers.c';path.write_text(source)
        self.synthetic_sha256=hashlib.sha256(source.encode()).hexdigest()
        subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror','-pthread',
            '-DORKESTR_TEST_AUTHORITY_CORE='+json.dumps(str(self.package.data/'core.sqlite3')),
            str(path),'-o',str(self.package.root/'native')],check=True,capture_output=True,env={'PATH':'/usr/bin:/bin'})
        os.chown(self.package.root/'native',0,GID);(self.package.root/'native').chmod(0o550)
        for name in ('role','mode'):
            self.fixture.write_private(self.mapped/name,(self.fixture.workspace/name).read_bytes())
        self.fixture.workspace=self.mapped

    def drain(self,path):
        marker=self.package.data/'deploy-drain.request';marker.touch(mode=0o600)
        os.chown(marker,self.package.authority_uid,self.package.authority_gid)
        def closed():
            assert not self.pump_errors,self.pump_errors
            code,window=self.request(path+'/window')
            return window if code==200 and window['state']=='closed' and all(row['state']=='exited' for row in self.claims()) else None
        result=wait(closed,'all original primary/Worker trees retired',seconds=20);marker.unlink()
        status=self.package.data/'deploy-drain.status.json'
        wait(lambda:status.exists() and json.loads(status.read_text())['draining'] is False,'fixture drain released',seconds=5)
        return result

    def run(self):
        report=Rehearsal.run(self)
        path='/api/v2/conversations/'+self.conversation
        first=self.rows("SELECT id,native_session_id FROM production_runs WHERE role='deep'")
        assert len(first)==1
        previous=self.drain(path)
        for number in (2,3):
            key='synthetic-native-workers:'+str(number)
            code,receipt=self.request(path+'/messages','POST',{'client_message_id':key,
                'text':'synthetic ordinary HTTP input '+str(number),'author':'owner'})
            assert code==202,(code,receipt)
            code,current=self.request(path+'/window');assert code==200
            code,window=self.request(path+'/window','POST',{'request_key':'window:'+key,
                'input_message_id':receipt['message_id'],'input_event_id':receipt['event_id'],'input_request_key':key,
                'expected_generation':current['generation'],'window_id':None if number==2 else current['window_id'],
                'predecessor_window_id':previous['window_id'] if number==2 else None})
            assert code==201,(code,window)
            def accepted():
                assert not self.pump_errors,self.pump_errors
                rows=self.rows("SELECT id,role,state FROM production_runs WHERE message_id=?",(receipt['message_id'],))
                return rows if len(rows)==3 and all(row['state']=='succeeded' for row in rows) else None
            wait(accepted,'two Native Workers and exact resumed primary accepted',seconds=40)
        self.drain(path)
        primary=self.rows("SELECT id,native_session_id FROM production_runs WHERE role='deep'")
        tasks=self.rows('SELECT t.id,t.parent_run_id,t.request_key,t.execution_budget_ms,d.admitted_run_id,r.state,r.provider_kind,a.event_id AS accepted FROM worker_tasks t JOIN worker_provider_delegations d ON d.id=t.delegation_id JOIN production_runs r ON r.id=d.admitted_run_id JOIN production_acceptances a ON a.run_id=r.id')
        assert len(primary)==3 and len({row['native_session_id'] for row in primary})==1
        assert len(tasks)==6 and len({row['admitted_run_id'] for row in tasks})==6
        assert all(row['state']=='succeeded' and row['provider_kind']=='codex' and row['execution_budget_ms']==300000 for row in tasks)
        assert all(sum(row['parent_run_id']==parent['id'] for row in tasks)==2 for parent in primary)
        assert not self.rows("SELECT id FROM production_runs WHERE role='fast'")
        assert len(self.rows('SELECT run_id FROM production_auto_acceptances'))==9
        records=[json.loads(p.read_text()) for p in (self.package.ledger_directory/'managed-requests').glob('*.json')]
        assert len(records)==15 and all(row['state']=='completed' and row['result_sent'] for row in records)
        submitted=[row for row in records if row['request']['operation']=='worker_submit'];assert len(submitted)==6
        for row in submitted:
            task=next(task for task in tasks if task['id']==row['result']['task_id'])
            assert task['request_key']=='native-worker:'+row['request_id']
            assert task['parent_run_id']==row['source']['run_id']==row['result']['parent_run_id']
            assert row['result']['phase']=='completed' and row['result']['result']['acceptance_event_id']==task['accepted']
        assert any(row['source'].get('resume_setup_id') is None for row in submitted)
        assert any(row['source'].get('resume_setup_id') for row in submitted)
        trace=[json.loads(line) for line in (self.fixture.account/'sessions/synthetic-role.jsonl').read_text().splitlines()]
        assert len([row for row in trace if row['kind']=='workers-finished'])==3
        assert len([row for row in trace if row['kind']=='worker-result'])==12
        assert any(row['kind']=='ready' and row['resumed'] and row['role']=='deep' for row in trace)
        assert all(row['state']=='exited' for row in self.claims())
        report.update(code_subject=code_subject(self.package),native_worker_bridge=True,parallel_workers_per_primary=2,
            accepted_primary_turns=3,accepted_worker_runs=6,owner_system_acceptance=True,same_native_identity=True,
            fresh_and_resumed_native_consumption=True,worker_task_evidence=tasks,
            synthetic_native_source_sha256=self.synthetic_sha256,actual_provider=False,live_activation=False)
        return report


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('binary')
    parser.add_argument('--expected-source',required=True);parser.add_argument('--report',required=True)
    args=parser.parse_args();assert os.geteuid()==0;os.umask(0o077)
    case=NativeWorkerRehearsal(args.binary,args.expected_source)
    report={'passed':False,'actual_provider':False,'live_activation':False}
    try:report.update(case.run(),passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__,error=str(error),manager_errors=case.pump_errors,
            launches=case.claims(),runs=case.rows('SELECT id,role,state FROM production_runs'))
        raise
    finally:
        try:case.close();report['cleanup_completed']=True
        finally:
            path=Path(args.report);path.write_text(json.dumps(report,indent=2)+'\n');path.chmod(0o600)
    print('synthetic fresh/resumed Native Worker bridge passed')


if __name__=='__main__':main()
