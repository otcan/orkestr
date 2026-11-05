"""Opt-in real Core/Root/Worker command and background/cancel HTTP rehearsal.

Only disposable numeric identities, projects, keys and a fixed synthetic native.
Run in the same explicitly delegated bounded scope as the anchor component
oracle. No real provider, business connector, live configuration or ACL writes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from identity_split_service_http import Rehearsal, ROOT, UID, GID, wait
from managed_workspace_anchor_linux import scope


class WorkspaceRehearsal(Rehearsal):
    def __init__(self,binary,jobs,project_owner=None):
        super().__init__(binary,'workers')
        self.project_owner=UID if project_owner is None else project_owner
        assert self.project_owner in (UID,UID+1),'only disposable fixture identities'
        self.jobs_root=jobs
        self.project=self.fixture.directory('managed-business-project')
        git=self.project/'.git';git.mkdir(mode=0o700);os.chown(git,UID,GID)
        self.secret=self.fixture.root/'selected-business.env'
        self.secret.write_text('BUSINESS_ACCOUNT_KEY=synthetic-selected\nUNSELECTED_KEY=synthetic-excluded\n')
        self.secret.chmod(0o600)
        self.probe=self.project/'command-probe.py'
        self.probe.write_text('import ctypes,json,os\nfrom pathlib import Path\n'
            f'assert os.geteuid()=={UID}\nassert os.getgroups()==[]\n'
            'assert ctypes.CDLL(None).prctl(39,0,0,0,0)==1\n'
            'assert os.environ["BUSINESS_ACCOUNT_KEY"]=="synthetic-selected"\n'
            'assert "UNSELECTED_KEY" not in os.environ\n'
            f'try:Path({str(self.package.data/"core.sqlite3")!r}).read_bytes()\n'
            'except PermissionError:pass\nelse:raise AssertionError("Core readable")\n'
            'Path("command-proof").write_text(json.dumps({"uid":os.geteuid(),"nnp":True,"core_denied":True,"selected_only":True}))\n'
            'print("managed workspace proof")\n')
        self.probe.chmod(0o600);os.chown(self.probe,UID,GID)
        if self.project_owner!=UID:
            for path in (self.project,git,self.probe):os.chown(path,self.project_owner,GID)
            for path in (self.project,git):
                subprocess.run(['/usr/bin/setfacl','-m',f'u:{UID}:rwx,g::---,o::---',str(path)],check=True)
            subprocess.run(['/usr/bin/setfacl','-m',f'u:{UID}:r--,g::---,o::---',str(self.probe)],check=True)
        for role,path in self.role_workspaces.items():
            if not role.startswith('worker-'):continue
            command=path/'workspace-command';command.write_text('/usr/bin/python3 -I -S -B '+str(self.probe)+'\n')
            command.chmod(0o600);os.chown(command,UID,GID)
        subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror',
            '-DORKESTR_TEST_WORKSPACE_TOOLS=1',
            '-DORKESTR_TEST_AUTHORITY_CORE='+json.dumps(str(self.package.data/'core.sqlite3')),
            str(ROOT/'v2/tests/service_roles_native.c'),'-o',str(self.package.root/'native')],
            check=True,capture_output=True,env={'PATH':'/usr/bin:/bin'})
        os.chown(self.package.root/'native',0,GID);(self.package.root/'native').chmod(0o550)
        self.refresh_manifest()

    def initialize_core(self):
        super().initialize_core()
        path=self.package.root/'beta.json';value=json.loads(path.read_text())
        import uuid
        value['workspace_exec']={'conversation_id':self.conversation,'project_id':str(uuid.uuid4()),
            'project_owner_uid':self.project_owner,
            'workspace':str(self.project),'allowed_roots':[str(self.project)],
            'protected_roots':[str(self.package.home)],'cgroup_root':str(self.jobs_root),
            'toolchain_root':str(self.fixture.root/'unused-legacy-command-image'),
            'trusted':{'network':True,'host_toolchain':True,'memory_bytes':256*1024**2,
                'pids':16,'cpus':1,'file_bytes':1024**2,'open_files':256,
                'command_timeout_ms':5000,'command_output_bytes':8192,'max_jobs':1,
                'job_timeout_ms':20000,'job_output_bytes':8192,'worker_run_ms':30000,
                'managed_executor':{'environment':{'HOME':str(self.fixture.home),'PATH':'/usr/bin:/bin'},
                    'credentials':[{'path':str(self.secret),'keys':['BUSINESS_ACCOUNT_KEY']}]}}}
        path.write_text(json.dumps(value));self.refresh_manifest()

    def run(self):
        report=super().run()
        proof=json.loads((self.project/'command-proof').read_text())
        assert proof=={'uid':UID,'nnp':True,'core_denied':True,'selected_only':True}
        assert self.project.stat().st_uid==self.project_owner
        claims=[json.loads(path.read_text()) for path in (self.package.ledger_directory/'workspace-commands').glob('*.json')]
        assert len(claims)==4 and all(row['cleanup'] for row in claims),claims
        assert sorted((row['kind'],row['state']) for row in claims)==[('command','complete')]*2+[('start','cancelled')]*2
        assert not list(self.jobs_root.iterdir()) or all(not path.is_dir() for path in self.jobs_root.iterdir())
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            rows=db.execute('SELECT state,count(*) FROM workspace_exec_delegations GROUP BY state').fetchall()
            count=db.execute('SELECT count(*) FROM workspace_exec_results').fetchone()[0]
            deliveries=db.execute('SELECT state,count(*) FROM workspace_exec_results GROUP BY state').fetchall()
        assert sum(number for _,number in rows)==8 and count==8,(rows,count)
        assert deliveries==[('delivered',8)],deliveries
        report.update(actual_consumed_workspace_commands=8,durable_root_claims=4,
            foreground_commands=2,background_starts=2,status_controls=2,cancel_controls=2,
            core_result_rows=count,core_delegation_states=rows,original_root_anchor_cleanup=True,
            project_owner_uid=self.project_owner,project_owner_preserved=True,named_executor_acl=self.project_owner!=UID,
            selected_business_environment=True,core_read_denied=True,nn_privileges=True)
        return report

    def diagnostics(self):
        value={'pump_errors':self.pump_errors,'native_failures':{},'root_commands':[]}
        for role,account in self.role_accounts.items():
            failure=account/'sessions/synthetic-failure'
            if failure.exists():value['native_failures'][role]=failure.read_text()[:1024]
        for path in (self.package.ledger_directory/'workspace-commands').glob('*.json'):
            row=json.loads(path.read_text())
            value['root_commands'].append({key:row.get(key) for key in ('kind','state','cleanup','exit_code','cancelled','cancellation')})
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            value['delegations']=db.execute('SELECT state,count(*) FROM workspace_exec_delegations GROUP BY state').fetchall()
            value['results']=db.execute('SELECT state,success,count(*) FROM workspace_exec_results GROUP BY state,success').fetchall()
        return value


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('binary');parser.add_argument('--report',required=True)
    parser.add_argument('--project-owner-uid',type=int)
    args=parser.parse_args();os.umask(0o077)
    base,jobs=scope();rehearsal=None;report={'passed':False,'live_activation':False,'actual_provider':False}
    try:
        rehearsal=WorkspaceRehearsal(args.binary,jobs,args.project_owner_uid)
        report.update(rehearsal.run());report['passed']=True
    except BaseException as error:
        report.update(error_type=type(error).__name__,error=str(error))
        if rehearsal is not None:report['diagnostics']=rehearsal.diagnostics()
        raise
    finally:
        try:
            if rehearsal is not None:rehearsal.close()
            jobs.rmdir();report['disposable_data_removed']=True
        except BaseException as cleanup:
            report['cleanup_error']=type(cleanup).__name__+': '+str(cleanup);report['passed']=False
        report['scope_memory_peak_bytes']=int((base/'memory.peak').read_text())
        report['harness_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        Path(args.report).write_text(json.dumps(report,indent=2)+'\n');Path(args.report).chmod(0o600)
    assert report['passed'],report
    print(json.dumps({'passed':True,'actual_core':True,'actual_provider':False,'workspace_operations':8}))


if __name__=='__main__':main()
