"""Disposable Core/Root/native HTTP capabilities and long owner wait oracle.

No provider request, real desktop/Vault, live configuration or owner review.
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
from identity_split_host_http import HostRehearsal
from identity_split_service_http import ROOT,GID,process,digest


class ManagedRehearsal(HostRehearsal):
    def __init__(self,binary,provider='codex',wait_seconds=120):
        self.wait_seconds=wait_seconds;self.completion_wait_seconds=wait_seconds+45
        super().__init__(binary,provider)
        source=self.server_identity.get('source_commit')
        assert type(source) is str and len(source)==40 and all(c in '0123456789abcdef' for c in source), 'source-stamped server required'
        if provider=='claude':
            executable=self.fixture.root/'synthetic-claude'
            subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror',
                '-DORKESTR_TEST_AUTHORITY_CORE='+json.dumps(str(self.package.data/'core.sqlite3')),
                '-DORKESTR_TEST_WORKSPACE='+json.dumps(str(self.mapped)),
                str(ROOT/'v2/tests/managed_mcp_claude_native.c'),'-o',str(executable)],
                check=True,capture_output=True,env={'PATH':'/usr/bin:/bin'})
            os.chown(executable,0,GID);executable.chmod(0o550);self.refresh_manifest()

    def configure_host_native(self):
        super().configure_host_native()
        path=self.fixture.root/'synthetic-managed-host.c';source=path.read_text()
        begin=source.index('    if (argc != 4')
        end=source.index('#ifdef ORKESTR_TEST_AUTHORITY_CORE',begin)
        source=source[:begin]+'    mcp_configuration(argc,argv);\n'+source[end:]
        source=source.replace('int main(int argc, char **argv) {',
            '#include '+json.dumps(str(ROOT/'v2/tests/managed_mcp_native.h'))+'\nint main(int argc, char **argv) {')
        source=source.replace('alarm(90);','alarm(330);')
        source=source.replace('            char mode[32];',
            '''            mcp_request("orkestr_root_request_submit", "{\\"action\\":\\"synthetic-task\\",\\"resource\\":\\"example.invalid\\",\\"summary\\":\\"agent requested synthetic review\\"}", input);
            mcp_request("orkestr_desk_login", "{\\"operation_id\\":\\"synthetic-login\\"}", input);
            char mode[32];''')
        path.write_text(source);self.synthetic_sha256=hashlib.sha256(source.encode()).hexdigest()
        subprocess.run(['/usr/bin/cc','-std=c11','-O2','-Wall','-Wextra','-Werror',
            '-DORKESTR_TEST_AUTHORITY_CORE='+json.dumps(str(self.package.data/'core.sqlite3')),
            str(path),'-o',str(self.package.root/'native')],check=True,capture_output=True,
            env={'PATH':'/usr/bin:/bin'})
        os.chown(self.package.root/'native',0,GID);(self.package.root/'native').chmod(0o550)

    def initialize_core(self):
        super().initialize_core()
        self.marker=self.fixture.root/'root-helper-proof.jsonl'
        helper=self.fixture.root/'fixed-approved-helper'
        helper.write_text('''#!/usr/bin/python3
import json,os,sys,time
from pathlib import Path
assert os.geteuid()==0
assert sys.argv[1:]==['--conversation',%r,'--desk','synthetic-desk','example.invalid']
assert set(os.environ)<=set(['PATH','LANG','PYTHONDONTWRITEBYTECODE','LC_CTYPE'])
marker=Path(%r);first=not marker.exists()
with marker.open('a') as stream:stream.write(json.dumps({'helper':os.getpid(),'helper_uid':os.geteuid(),'started_ms':time.time_ns()//1000000})+'\\n')
marker.chmod(0o600)
if first:time.sleep(%r)
'''%(self.conversation,str(self.marker),self.wait_seconds))
        helper.chmod(0o550)
        definition=self.fixture.root/'approved-desk-operations.json'
        definition.write_text(json.dumps({'format':'orkestr-desk-operations-v1','operations':{'synthetic-login':{
            'helper':str(helper),'sha256':digest(helper),'conversation_id':self.conversation,
            'desk':'synthetic-desk','site':'example.invalid','duration_ms':180000}}}))
        definition.chmod(0o440)
        service=self.package.root/'service.json';value=json.loads(service.read_text())
        value.update(managed_operations=True,desk_login={'path':str(definition),'sha256':digest(definition)})
        service.write_text(json.dumps(value));self.refresh_manifest()

    def run(self):
        report=super().run()
        markers=[json.loads(line) for line in self.marker.read_text().splitlines()]
        assert len(markers)==3 and all(process(row['helper']) is None for row in markers),markers
        records=[json.loads(p.read_text()) for p in (self.package.ledger_directory/'managed-requests').glob('*.json')]
        assert len(records)==6 and all(r['state']=='completed' and r['result_sent'] and r['result_authorization'] for r in records),records
        desk=[r for r in records if r['request']['operation']=='desk_login']
        first=min(desk,key=lambda r:r['created_at_ms'])
        if self.wait_seconds>20:
            assert first['latest_capability']['lease_generation']>first['capability']['lease_generation']
        assert all(r['result']['cleanup'] for r in desk)
        assert markers[1]['started_ms']-markers[0]['started_ms']>=self.wait_seconds*1000
        intake=list((self.package.ledger_directory/'root-request-submissions').glob('*.json'))
        assert len(intake)==3
        for file in intake:
            value=json.loads(file.read_text());assert value['owner_approved'] is False and value['owner_instruction_reference'] is None
            assert value['core_input_reference']['message_id']
        with sqlite3.connect((self.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True) as db:
            rows=db.execute('SELECT state,count(*) FROM managed_operations GROUP BY state').fetchall()
        assert sorted(rows)==[('helper_completed',3),('submitted',3)],rows
        report.update(managed_http_capabilities=True,owner_wait_seconds=self.wait_seconds,
            exact_original_helper_renewed=True,one_helper_per_turn=True,protected_root_intake_count=3,
            core_fenced_result_delivery=True,native_resume_tools_preserved=True,owner_review_delivered=False,
            real_desktop=False,real_vault=False)
        return report


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('binary');parser.add_argument('--report',required=True)
    parser.add_argument('--wait-seconds',type=int,default=120)
    parser.add_argument('--provider',choices=('codex','claude'),default='codex')
    args=parser.parse_args();assert os.geteuid()==0 and 0<=args.wait_seconds<=120
    os.umask(0o077);case=ManagedRehearsal(args.binary,args.provider,wait_seconds=args.wait_seconds)
    report={'passed':False,'live_activation':False}
    try:report.update(case.run(),passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__,error=str(error),manager_errors=case.pump_errors)
        report['synthetic_root_records']={name:[json.loads(p.read_text()) for p in
            (case.package.ledger_directory/name).glob('*.json')]
            for name in ('launches','managed-requests','native-registrations','desk-operations')}
        report['synthetic_trace']=(case.fixture.account/'sessions/synthetic-role.jsonl').read_text() if (case.fixture.account/'sessions/synthetic-role.jsonl').exists() else None
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
    print('synthetic managed HTTP capability flow passed')


if __name__=='__main__':main()
