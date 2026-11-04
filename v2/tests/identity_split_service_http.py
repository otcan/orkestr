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
from codex_service.package import Package
from codex_service.entry import verified,write_seal


def wait(operation,label,seconds=15):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        result=operation()
        if result:return result
        time.sleep(.01)
    raise AssertionError(label)


class Rehearsal:
    def __init__(self,binary):
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
        self.process=None;self.manager=None
        self.pump=None;self.pump_stop=threading.Event();self.pump_errors=[]
        self.binary=Path(binary).resolve(strict=True)
        self.origin=f'http://127.0.0.1:{self.port}'
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.bootstrap='synthetic-owner-bootstrap-token-long-enough'
        self.browser_headers={}
        shutil.copyfile(self.binary,self.package.root/'server');(self.package.root/'server').chmod(0o550)
        # All account content is a disposable dummy, not a real login.
        self.fixture.auth.write_bytes(b'{"fixture":"synthetic-roles-only"}\n')
        for name,value in [('role','deep'),('mode','complete')]:
            path=self.fixture.workspace/name;path.write_text(value);path.chmod(0o600);os.chown(path,UID,GID)
        subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror',
                        '-DORKESTR_TEST_AUTHORITY_CORE='+json.dumps(str(self.package.data/'core.sqlite3')),
                        str(ROOT/'v2/tests/selected_codex_roles_native.c'),'-o',str(self.package.root/'native')],
                       check=True,capture_output=True,env={'PATH':'/usr/bin:/bin'})
        os.chown(self.package.root/'native',0,GID);(self.package.root/'native').chmod(0o550)
        self.refresh_manifest()

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
            try:return dispatch(*args,**kwargs)
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
        def ready():self.manager.once();return self.owns_listener()
        wait(ready,'authority server and manager ready')
        def pump():
            try:
                while not self.pump_stop.is_set():self.manager.once()
            except BaseException as error:self.pump_errors.append(type(error).__name__+': '+str(error))
        self.pump=threading.Thread(target=pump,daemon=True);self.pump.start()

    def run(self):
        self.initialize_core();self.start_rehearsal()
        path=f'/api/v2/conversations/{self.conversation}'
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
        core=self.package.data/'core.sqlite3'
        def accepted():
            assert not self.pump_errors,self.pump_errors
            with sqlite3.connect(core.as_uri()+'?mode=ro',uri=True) as db:
                db.execute('PRAGMA query_only=ON')
                return db.execute("SELECT id,state,native_session_id FROM production_runs WHERE message_id=? AND role='deep' AND state='succeeded'",(admitted['message_id'],)).fetchone()
        row=wait(accepted,'Core accepted synthetic Codex completion',seconds=30)
        trace=self.fixture.account/'sessions/synthetic-role.jsonl'
        records=[json.loads(line) for line in trace.read_text().splitlines()]
        assert any(r['kind']=='turn' for r in records)
        children=[record.identity for window in self.manager.windows.values() for record in window.children.records.values()]
        assert children and all(r['uid']==UID for r in children)
        assert core.stat().st_uid==self.package.authority_uid!=UID
        for child in children:
            if exists(child):assert 'NoNewPrivs:\t1' in Path('/proc',str(child['pid']),'status').read_text()
        return dict(core_run_id=row[0],core_run_state=row[1],native_session_id=row[2],
                    authority_uid=self.package.authority_uid,executor_uid=UID,managed_children=children,
                    synthetic_native_turns=sum(r['kind']=='turn' for r in records),
                    actual_provider=False,live_activation=False,production_startup_gate_bypassed_only_in_test=True)

    def close(self):
        self.pump_stop.set()
        if self.pump:self.pump.join(timeout=3)
        if self.manager:
            clean=self.manager.close()
            if self.process and self.process.stderr:self.process.stderr.close()
            self.process=None
            assert clean,'managed shutdown failed custody/reap proof'
        else:self.stop_raw()
        self.fixture.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary');parser.add_argument('--report',required=True)
    args=parser.parse_args();assert os.geteuid()==0,'root-only synthetic test'
    os.umask(0o077)
    case=Rehearsal(args.binary);report={'passed':False,'actual_provider':False,'live_activation':False}
    try:report.update(case.run(),passed=True)
    except BaseException as error:
        report['error_type']=type(error).__name__;report['fixture']=str(case.fixture.root)
        report['error']=str(error);report['manager_errors']=case.pump_errors
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
        finally:
            fd=os.open(args.report,os.O_CREAT|os.O_WRONLY|os.O_TRUNC,0o600)
            with os.fdopen(fd,'w') as stream:json.dump(report,stream,indent=2)
    print('synthetic managed Core/Codex FD flow passed')

if __name__=='__main__':main()
