"""Explicit root-only Core + managed Codex FD rehearsal, fixed synthetic native.

The production split startup gate remains held. This test harness reproduces its
proposed root-owned start path only inside disposable fixtures; not a release,
real provider, credential migration, live account or deployment qualification.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import threading
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'v2/provider-broker'))
from codex_service_fixture import ServiceFixture,UID,GID
from test_codex_service_identity import SplitPackageTests
from codex_bounded.trust import digest,process,exists
from codex_service.manager import Manager
from codex_service.channel import ServerPeer
from codex_service.package import Package,CLAUDE_BROKER
from codex_service.entry import verified,write_seal
from codex_service.contract import Refused
from codex_service.qualification import code_subject


def wait(operation,label,seconds=15):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        result=operation()
        if result:return result
        time.sleep(.01)
    raise AssertionError(label)


class Rehearsal:
    def __init__(self,binary,provider='codex',attachment_export=False,fault_orphan=False):
        self.provider=provider
        self.attachment_export=attachment_export
        self.fault_orphan=fault_orphan;self.fault_injected=False;self.held_observers={}
        assert not fault_orphan or provider=='claude','fault fixture uses managed host Claude'
        assert not attachment_export or provider=='codex','scoped attachment fixture uses bounded Codex'
        self.fixture=ServiceFixture();self.uid=UID;self.gid=GID;self.digest=digest
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));self.port=listener.getsockname()[1]
        self.fixture.plan['port']=self.port
        self.fixture.prepare()
        # The fixture helper mkdir modes inherit the caller umask, whereas
        # production packaging sets explicit group-readable closure modes.
        for directory in [self.fixture.package,*[p for p in self.fixture.package.rglob("*") if p.is_dir()]]:
            directory.chmod(0o750)
        self.fixture.endpoint.chmod(0o750)
        (self.fixture.package/'beta.json').chmod(0o640)
        self.package=SplitPackageTests.select_split(self)
        if attachment_export:
            self.exports=self.fixture.root/'exports';self.exports.mkdir(mode=0o700)
            os.chown(self.exports,self.package.authority_uid,GID)
            service=self.package.root/'service.json';value=json.loads(service.read_text())
            value['attachment_export_dir']=str(self.exports);service.write_text(json.dumps(value))
            self.other_export=self.exports/'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            self.other_export.mkdir(mode=0o750);os.chown(self.other_export,self.package.authority_uid,GID)
            self.other_export.chmod(0o750)
            foreign=self.other_export/'fixture.txt';foreign.write_text('other conversation')
            foreign.chmod(0o640);os.chown(foreign,self.package.authority_uid,GID)
        self.process=None;self.manager=None
        self.pump=None;self.pump_stop=threading.Event();self.pump_errors=[]
        self.binary=Path(binary).resolve(strict=True)
        self.origin=f'http://127.0.0.1:{self.port}'
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.bootstrap='synthetic-owner-bootstrap-token-long-enough'
        self.browser_headers={}
        shutil.copyfile(self.binary,self.package.root/'server');(self.package.root/'server').chmod(0o550)
        # The disposable package must describe the copied Core, not the
        # fixture's placeholder source. Peer-bound clients independently pin
        # this value before sending any cookie/key to its original process.
        copied_identity=json.loads(subprocess.check_output([str(self.package.root/'server'),'--version','--json'],
            env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},cwd='/'))
        self.server_identity=copied_identity
        self.server_sha256=hashlib.sha256((self.package.root/'server').read_bytes()).hexdigest()
        copied_source=copied_identity.get('source_commit')
        if copied_source is not None:
            assert type(copied_source) is str and len(copied_source)==40 and all(c in '0123456789abcdef' for c in copied_source)
            manifest_path=self.package.root/'manifest.json';manifest=json.loads(manifest_path.read_text())
            manifest['source_commit']=copied_source;manifest_path.write_text(json.dumps(manifest))
        # All account content is a disposable dummy, not a real login.
        self.fixture.auth.write_bytes(b'{"fixture":"synthetic-roles-only"}\n')
        for name,value in [('role','deep'),('mode','complete')]:
            path=self.fixture.workspace/name;path.write_text(value);path.chmod(0o600);os.chown(path,UID,GID)
        subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror',
                        '-DORKESTR_TEST_AUTHORITY_CORE='+json.dumps(str(self.package.data/'core.sqlite3')),
                        *(['-DORKESTR_TEST_ATTACHMENT=1','-DORKESTR_TEST_OTHER_ATTACHMENT='+
                           json.dumps(str(self.other_export/'fixture.txt'))] if attachment_export else []),
                        str(ROOT/('v2/tests/service_roles_native.c' if provider=='workers' else
                                  'v2/tests/selected_codex_roles_native.c')),'-o',str(self.package.root/'native')],
                       check=True,capture_output=True,env={'PATH':'/usr/bin:/bin'})
        os.chown(self.package.root/'native',0,GID);(self.package.root/'native').chmod(0o550)
        if provider=='claude':self.configure_claude()
        if provider=='workers':self.configure_roles()
        self.refresh_manifest()

    def configure_roles(self):
        package=self.package.root
        base=json.loads((package/'profile.json').read_text())
        beta_path=package/'beta.json';beta=json.loads(beta_path.read_text())
        manifest_path=package/'manifest.json';manifest=json.loads(manifest_path.read_text())
        roles={};self.role_workspaces={'deep':self.fixture.workspace};self.role_accounts={'deep':self.fixture.account}
        for role in ('fast','worker-0','worker-1','worker-2','worker-3'):
            paths={}
            for key in ('workspace','state_root'):
                path=self.fixture.root/(role+'-'+key);path.mkdir(mode=0o700);os.chown(path,UID,GID)
                paths[key]=str(path)
            for name,value in [('role',role),('mode','complete')]:
                path=Path(paths['workspace'])/name;path.write_text(value);path.chmod(0o600);os.chown(path,UID,GID)
            self.role_workspaces[role]=Path(paths['workspace']);self.role_accounts[role]=Path(paths['state_root'])
            profile=package/('profile-'+role+'.json');profile.write_text(json.dumps({**base,**paths}))
            profile.chmod(0o440);os.chown(profile,0,GID)
            launcher=package/('launcher-'+role+'.py')
            launcher.write_text('#!/bin/sh\nexec '+str(Path('/usr/bin/python3').resolve())+
                ' -I -S -B "$(dirname -- "$0")/codex_service/entry.py" broker-'+role+' "$@"\n')
            launcher.chmod(0o550);os.chown(launcher,0,GID)
            roles[role]={'launcher':str(launcher),'launcher_sha256':digest(launcher),'workspace':paths['workspace']}
            for path in (profile,launcher):manifest['files'][path.name]=digest(path)
        beta['roles']={'fast':roles['fast'],'workers':[roles['worker-'+str(i)] for i in range(4)]}
        beta_path.write_text(json.dumps(beta));manifest_path.write_text(json.dumps(manifest))
        (self.fixture.workspace/'mode').write_text('hold')

    def exercise_worker_reuse(self,path):
        def launches():
            return [value for p in (self.package.ledger_directory/'launches').glob('*.json')
                    if (value:=json.loads(p.read_text()))['role']=='worker-0']
        def running():
            code,value=self.request(path+'/execution')
            return value if code==200 and value['phase']=='running' else None
        parent=wait(running,'live parent Deep for workers')
        tasks=path+'/worker-tasks?parent_run_id='+parent['run_id']
        wait(lambda:self.request(tasks)[1]['can_create'],'Core worker scheduler')
        completed=[]
        for number in (41,42):
            parent=wait(running,'exact parent control revision')
            code,task=self.request(path+'/worker-tasks','POST',{'parent_run_id':parent['run_id'],
                'expected_control_revision':parent['control_revision'],'request_key':'split-worker:'+str(number),
                'title':'Synthetic split Worker','instructions':'synthetic ordinary HTTP input '+str(number),
                'lifetime_ms':30000})
            assert code==200,(code,task)
            def done():
                assert not self.pump_errors,self.pump_errors
                code,value=self.request(tasks);assert code==200,(code,value)
                row=next(row for row in value['tasks'] if row['task']['task_id']==task['task_id'])
                return row if row['phase']=='completed' else None
            completed.append(wait(done,'accepted fresh worker slot reuse',seconds=30))
            def reaped():
                rows=launches()
                return rows if len(rows)==number-40 and all(row['state']=='exited' and
                    not exists({'pid':row['proxy_pid'],'start':row['proxy_start'],'uid':self.package.authority_uid})
                    for row in rows) else None
            wait(reaped,'exact worker-0 proxy and real tree reap',seconds=15)
        rows=launches()
        assert len({row['setup']['session_id'] for row in rows})==2
        self.worker_setups=[row['setup'] for row in rows]
        (self.fixture.workspace/'release-1').touch()
        return completed

    def configure_claude(self):
        """Fixed synthetic Claude with executor NNP and real Core-read denial."""
        directories={}
        for key in ('account','workspace','home','temporary'):
            path=self.fixture.root/('claude-'+key);path.mkdir(mode=0o700);os.chown(path,UID,GID)
            directories[key]=str(path)
        executable=self.fixture.root/'synthetic-claude'
        proof=("import ctypes,os\nassert os.geteuid()==%d\nassert ctypes.CDLL(None).prctl(39,0,0,0,0)==1\n"
               "try:\n open(%r,'rb')\nexcept PermissionError:pass\nelse:raise AssertionError('Core exposed')\n"%
               (UID,str(self.package.data/'core.sqlite3')))
        if self.fault_orphan:
            proof+='''from pathlib import Path
import time
forked=os.fork()
if forked==0:
 os.setsid();grandchild=os.fork()
 Path('fault-child' if grandchild else 'fault-grandchild').write_text(str(os.getpid()))
 while True:time.sleep(1)
while not (Path('fault-child').exists() and Path('fault-grandchild').exists()):time.sleep(.01)
Path('fault-ready').write_text(str(os.getpid()))
while True:time.sleep(1)
'''
        native=(ROOT/'v2/tests/service_claude_native.py').read_text()
        executable.write_text(native.replace('import json',proof+'\nimport json',1));executable.chmod(0o555)
        package=self.package.root
        interpreter=str(Path('/usr/bin/python3').resolve())
        launcher=package/'launcher-claude.py'
        launcher.write_text('#!/bin/sh\nexec '+interpreter+' -I -S -B "$(dirname -- "$0")/codex_service/entry.py" broker-claude "$@"\n')
        launcher.chmod(0o550);os.chown(launcher,0,GID)
        private={**directories,'executable':str(executable),
                 'managed_host':{'environment':{'HOME':directories['home'],'PATH':'/usr/bin:/bin',
                                               'TMPDIR':directories['temporary']}}}
        profile=package/'claude-private.json';profile.write_text(json.dumps(private));profile.chmod(0o440);os.chown(profile,0,GID)
        beta_path=package/'beta.json';beta=json.loads(beta_path.read_text())
        beta['claude']={'launcher':str(launcher),'launcher_sha256':digest(launcher),
                        'workspace':directories['workspace'],'default':True,'fast':not self.fault_orphan}
        beta_path.write_text(json.dumps(beta))
        manifest_path=package/'manifest.json';manifest=json.loads(manifest_path.read_text())
        for name in CLAUDE_BROKER:
            destination=package/'broker'/name
            if not destination.exists():
                shutil.copyfile(ROOT/'v2/provider-broker'/name,destination);destination.chmod(0o440);os.chown(destination,0,GID)
            manifest['files']['broker/'+name]=digest(destination)
        for name in ('launcher-claude.py','claude-private.json'):manifest['files'][name]=digest(package/name)
        manifest_path.write_text(json.dumps(manifest))

    def refresh_manifest(self):
        path=self.fixture.package/'manifest.json';value=json.loads(path.read_text())
        for name in value['files']:value['files'][name]=digest(self.fixture.package/name)
        path.write_text(json.dumps(value));self.manifest=digest(path)
        self.package=Package(self.fixture.package,self.manifest)

    def request(self,path,method='GET',body=None,headers=None):
        request=urllib.request.Request(self.origin+path,method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={**({'Content-Type':'application/json'} if body is not None else {}),**self.browser_headers,**(headers or {})})
        try:response=self.opener.open(request,timeout=3)
        except urllib.error.HTTPError as error:response=error
        with response:
            raw=response.read();return response.status,json.loads(raw) if raw else None

    def owns_listener(self):
        if self.process.poll() is not None:
            raise AssertionError('synthetic server exited: '+self.process.stderr.read(4096).decode(errors='replace'))
        base=Path('/proc',str(self.process.pid));owned=set()
        for fd in (base/'fd').iterdir():
            try:link=os.readlink(fd)
            except FileNotFoundError:continue
            if link.startswith('socket:['):owned.add(link[8:-1])
        for line in (base/'net/tcp').read_text().splitlines()[1:]:
            fields=line.split()
            if fields[1]==f'0100007F:{self.port:04X}' and fields[3]=='0A' and fields[9] in owned:return True
        return False

    def initialize_core(self):
        env=self.package.environment();env.pop('ORKESTR_V2_BETA_CONFIG')
        env['ORKESTR_V2_BOOTSTRAP_TOKEN']=self.bootstrap
        self.process=subprocess.Popen([str(self.package.root/'server')],env=env,cwd='/',
            user=self.package.authority_uid,group=GID,extra_groups=[],stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        wait(self.owns_listener,'exact bootstrap listener')
        credentials={'username':'synthetic-owner','password':'synthetic-password-split-identity'}
        status,reply=self.request('/api/v2/setup','POST',credentials,{'x-orkestr-bootstrap':self.bootstrap})
        assert status==201
        self.conversation=reply['global_conversation_id']
        status,reply=self.request('/api/v2/machine/session','POST',credentials)
        assert status==200
        self.token=reply['token']
        request=urllib.request.Request(self.origin+'/api/v2/browser/session',method='POST',
            data=json.dumps(credentials).encode(),headers={'Content-Type':'application/json','Origin':self.origin})
        with self.opener.open(request,timeout=3) as response:
            session=json.load(response)
            self.browser_headers={'Cookie':response.headers['Set-Cookie'].split(';',1)[0],
                'x-orkestr-csrf':session['csrf_token'],'Origin':self.origin}
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            self.owner=db.execute('SELECT owner_id FROM conversations WHERE id=?',(self.conversation,)).fetchone()[0]
        self.stop_raw()
        for name in ('service.json','beta.json'):
            path=self.package.root/name;value=json.loads(path.read_text())
            value.update(owner_id=self.owner,conversation_id=self.conversation);path.write_text(json.dumps(value))
        self.refresh_manifest()
        if self.attachment_export:
            export=self.exports/self.conversation;export.mkdir(mode=0o700)
            os.chown(export,self.package.authority_uid,GID)
            file=export/'fixture.txt';file.write_text('synthetic authorized attachment\n')
            file.chmod(0o640);os.chown(file,self.package.authority_uid,GID)
            # This disposable owner-writable canary distinguishes RO mounting
            # from the published attachment's independent DAC write denial.
            canary=export/'writable-canary';canary.write_text('unchanged')
            canary.chmod(0o600);os.chown(canary,UID,GID)
            reference=self.fixture.workspace/'attachment-path';reference.write_text(str(file))
            reference.chmod(0o600);os.chown(reference,UID,GID)

    def stop_raw(self):
        if self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
            try:self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=3)
        if self.process and self.process.stderr:self.process.stderr.close()
        self.process=None

    def start_rehearsal(self):
        # No configuration switch bypasses production gating. This explicit
        # test code alone reproduces the proposed start path in a disposable
        # root-owned fixture so the new FD flow can be exercised before rollout.
        assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
        seal,records=verified(self.package.root,self.manifest,sealed=False)
        write_seal(self.package.control.parent,GID,self.package.root,seal,records)
        self.manager=Manager(self.package.root,self.manifest)
        dispatch=self.manager.dispatch
        def observed_dispatch(*args,**kwargs):
            try:
                result=dispatch(*args,**kwargs)
                if self.fault_orphan and args[0]['operation']=='admit':
                    for key,window in self.manager.windows.items():
                        self.held_observers[key]=window.children.observe
                        window.children.observe=lambda:None
                return result
            except BaseException as error:
                self.pump_errors.append('dispatch: '+type(error).__name__+': '+str(error));raise
        self.manager.dispatch=observed_dispatch
        interpreter=str(Path('/usr/bin/python3').resolve())
        command=[interpreter,'-I','-S','-B',str(self.package.root/'codex_service/entry.py'),'server',str(os.getpid())]
        self.process=subprocess.Popen(command,env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},cwd='/',
            user=self.package.authority_uid,group=GID,extra_groups=[],stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,process_group=0)
        self.manager.child=self.process;self.manager.identity=process(self.process.pid)
        self.manager.peer=ServerPeer(self.manager.identity,self.package.root/'server')
        if hasattr(self.manager,'publish_service_peer'):
            self.manager.publish_service_peer()
        def ready():self.manager.once();return self.owns_listener()
        wait(ready,'authority server and manager ready')
        def pump():
            try:
                while not self.pump_stop.is_set():
                    ready=self.fixture.root/'claude-workspace/fault-ready'
                    if self.fault_orphan and not self.fault_injected and ready.exists():
                        directory=ready.parent
                        self.fault_originals=[process(int((directory/name).read_text())) for name in
                            ('fault-ready','fault-child','fault-grandchild')]
                        handle=next(iter(self.manager.launcher.children.values()))
                        assert all(len(window.children.records)==1 for window in self.manager.windows.values())
                        handle.child.kill()
                        deadline=time.monotonic()+3
                        while handle.child.poll() is None:
                            assert time.monotonic()<deadline;time.sleep(.001)
                        assert handle.child.returncode==-9
                        self.fault_injected=True
                        for key,observer in self.held_observers.items():self.manager.windows[key].children.observe=observer
                    self.manager.once()
            except BaseException as error:self.pump_errors.append(type(error).__name__+': '+str(error))
        self.pump=threading.Thread(target=pump,daemon=True);self.pump.start()

    def run(self):
        self.initialize_core();self.start_rehearsal()
        path=f'/api/v2/conversations/{self.conversation}'
        if self.provider=='claude':
            status,selected=self.request(path+'/settings','PUT',
                dict(expected_revision=0,provider='claude',model='synthetic-claude-model',
                     reasoning_effort='low',honor_no_reply=True,review_before_accepting=False))
            assert status==200 and selected['provider']=='claude',(status,selected)
        status,admitted=self.request(path+'/messages','POST',
            {'client_message_id':'synthetic-split-first','text':'synthetic ordinary HTTP input 1','author':'owner'},
            {})
        assert status==202,(status,admitted)
        status,window=self.request(path+'/window','POST',{
            'request_key':'window:synthetic-split-first','input_message_id':admitted['message_id'],
            'input_event_id':admitted['event_id'],'input_request_key':'synthetic-split-first',
            'expected_generation':0,'window_id':None,'predecessor_window_id':None},
            {})
        assert status==201,(status,window)
        if self.fault_orphan:return self.fault_result()
        workers=self.exercise_worker_reuse(path) if self.provider=='workers' else []
        core=self.package.data/'core.sqlite3'
        def accepted():
            assert not self.pump_errors,self.pump_errors
            with sqlite3.connect(core.as_uri()+'?mode=ro',uri=True) as db:
                db.execute('PRAGMA query_only=ON')
                return db.execute("SELECT id,state,native_session_id FROM production_runs WHERE message_id=? AND role='deep' AND state='succeeded'",(admitted['message_id'],)).fetchone()
        row=wait(accepted,'Core accepted synthetic Codex completion',seconds=getattr(self,'completion_wait_seconds',30))
        if self.provider=='claude':
            def fast_accepted():
                assert not self.pump_errors,self.pump_errors
                with sqlite3.connect(core.as_uri()+'?mode=ro',uri=True) as db:
                    return db.execute("SELECT id FROM production_runs WHERE message_id=? AND role='fast' AND state='succeeded'",(admitted['message_id'],)).fetchone()
            wait(fast_accepted,'Core accepted read-only Claude Fast',seconds=30)
        trace=(self.fixture.account/'sessions/synthetic-role.jsonl' if self.provider!='claude' else
               self.fixture.root/'claude-workspace/claude-peer.jsonl')
        records=[json.loads(line) for line in getattr(self,'trace_path',trace).read_text().splitlines()]
        assert any(r['kind']=='turn' for r in records)
        if self.provider=='claude':
            spawns=[r for r in records if r['kind']=='spawn']
            assert any(not r['read_only'] and r['model']=='synthetic-claude-model' and r['effort']=='low' for r in spawns),spawns
            assert any(r['read_only'] and r['model']=='sonnet' and r['effort']=='low' for r in spawns),spawns
        children=[record.identity for window in self.manager.windows.values() for record in window.children.records.values()]
        assert children and all(r['uid']==UID for r in children)
        assert core.stat().st_uid==self.package.authority_uid!=UID
        for child in children:
            if exists(child):assert 'NoNewPrivs:\t1' in Path('/proc',str(child['pid']),'status').read_text()
        export_evidence={}
        if self.attachment_export:
            from workflow_measured_evidence import attachment
            export_evidence=dict(attachment_export_evidence=attachment(self,row[0]),
                harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
        return dict(**export_evidence,code_subject=code_subject(self.package),server_identity=self.server_identity,
                    server_sha256=self.server_sha256,core_run_id=row[0],core_run_state=row[1],native_session_id=row[2],
                    authority_uid=self.package.authority_uid,executor_uid=UID,managed_children=children,
                    synthetic_native_turns=sum(r['kind']=='turn' for r in records),
                    worker_reuse_count=len(workers),worker_setups=getattr(self,'worker_setups',[]),
                    scoped_attachment_read_only=self.attachment_export,
                    claude_preferences_and_read_only_fast=self.provider=='claude',
                    provider=self.provider,actual_provider=False,live_activation=False,production_startup_gate_bypassed_only_in_test=True)

    def fault_result(self):
        def quarantined():
            assert not self.pump_errors,self.pump_errors
            return (self.fault_injected and self.manager.custody_fault and self.manager.adopted and
                self.manager.adopted.records and all(record.gone() for record in self.manager.adopted.records.values()))
        wait(quarantined,'unobserved owned orphans globally reaped and manager quarantined')
        self.pump_stop.set();self.pump.join(timeout=3)
        assert not self.pump.is_alive()
        assert all(not exists(identity) for identity in self.fault_originals)
        states=[self.manager.ledger.details(window.window,window.generation)
                for window in self.manager.windows.values()]
        assert states and all(state['state']=='reconciliation' for state in states)
        claims=[json.loads(path.read_text()) for path in (self.package.ledger_directory/'launches').glob('*.json')]
        assert claims and all(claim['state']=='unknown' and claim['exit_code']==-9 for claim in claims)
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            assert db.execute('SELECT count(*) FROM production_runs').fetchone()[0]==0
        for operation in ('admit','launch_child','retire','reconcile','extend'):
            try:self.manager.dispatch({'operation':operation,'owner_id':self.package.owner,'conversation_id':self.conversation})
            except Refused as error:assert str(error)=='manager_custody_fault'
            else:raise AssertionError('faulted manager admitted authority transition')
        self.fault_qualified=True
        return dict(code_subject=code_subject(self.package),server_identity=self.server_identity,
                    server_sha256=self.server_sha256,fault_injected=True,unobserved_orphans=len(self.manager.adopted.records),
            global_reaped=True,authority_transitions_fenced=True,window_states=[state['state'] for state in states],
            launch_states=[claim['state'] for claim in claims],broker_exit=-9,business_runs=0,
            manager_recovered=False,physical_cleanup_only=True,
            provider=self.provider,actual_provider=False,live_activation=False,production_startup_gate_bypassed_only_in_test=True)

    def close(self):
        self.pump_stop.set()
        if self.pump:self.pump.join(timeout=3)
        try:
            if self.manager:
                clean=self.manager.close()
                if self.process and self.process.stderr:self.process.stderr.close()
                self.process=None
                if self.fault_orphan:
                    from codex_service.ownership import Adopted
                    assert getattr(self,'fault_qualified',False) and not clean and self.manager.custody_fault
                    assert all(not exists(identity) for identity in self.fault_originals)
                    assert not Adopted.children(self.manager.adopted.parent),'root actor children remain'
                else:assert clean,'managed shutdown failed custody/reap proof'
            else:self.stop_raw()
        finally:self.fixture.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary');parser.add_argument('--report',required=True)
    parser.add_argument('--provider',choices=('codex','claude','workers'),default='codex')
    parser.add_argument('--attachment-export',action='store_true')
    parser.add_argument('--fault-orphan',action='store_true')
    args=parser.parse_args();assert os.geteuid()==0,'root-only synthetic test'
    os.umask(0o077)
    case=Rehearsal(args.binary,args.provider,args.attachment_export,args.fault_orphan);report={'passed':False,'actual_provider':False,'live_activation':False}
    try:report.update(case.run(),passed=True)
    except BaseException as error:
        report['error_type']=type(error).__name__;report['fixture']=str(case.fixture.root)
        report['error']=str(error);report['manager_errors']=case.pump_errors
        if case.fault_orphan:
            report['fault_injected']=case.fault_injected
            report['custody_fault']=bool(case.manager and case.manager.custody_fault)
            report['adopted_count']=len(case.manager.adopted.records) if case.manager and case.manager.adopted else 0
            report['fault_originals']=[dict(identity,live=exists(identity)) for identity in getattr(case,'fault_originals',[])]
        proof=case.fixture.account/'sessions/synthetic-attachment-proof'
        if proof.exists():report['synthetic_attachment_proof']=proof.read_text()
        report['launches']=[{k:value.get(k) for k in ('state','role','exit_code')} for p in
            (case.package.ledger_directory/'launches').glob('*.json') if (value:=json.loads(p.read_text()))]
        core=case.package.data/'core.sqlite3'
        if core.exists():
            with sqlite3.connect(core.as_uri()+'?mode=ro',uri=True) as db:
                report['runs']=db.execute('SELECT id,state,role FROM production_runs').fetchall()
        if case.process and case.process.stderr:
            fd=case.process.stderr.fileno();os.set_blocking(fd,False)
            try:report['synthetic_server_stderr']=os.read(fd,16384).decode(errors='replace')
            except BlockingIOError:pass
        raise
    finally:
        try:case.close();report['cleanup_completed']=True
        except BaseException as error:
            report['passed']=False;report['cleanup_error']=type(error).__name__+': '+str(error)
            raise
        finally:
            fd=os.open(args.report,os.O_CREAT|os.O_WRONLY|os.O_TRUNC,0o600)
            with os.fdopen(fd,'w') as stream:json.dump(report,stream,indent=2)
    print('synthetic managed Core/provider FD flow passed')

if __name__=='__main__':main()
