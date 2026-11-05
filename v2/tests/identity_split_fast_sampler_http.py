"""Actual exact-input Core Fast lookup joined to live Root tree/pipe samples.

Uses the existing three-input managed-host fixture. No provider account or
additional business/canary messages; snapshots exist only inside the fixture.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from identity_split_host_fast_http import FastHostRehearsal
from identity_split_claude_fast_http import ClaudeFastRehearsal
from codex_service.fast_sampler import capture,verify


class FastSamplerObservations:
    def initialize_samples(self):
        self.samples=self.fixture.root/'fast-proofs';self.samples.mkdir(mode=0o700)
        self.observations=[]

    def request(self,path,method='GET',body=None,headers=None):
        response=super().request(path,method,body,headers)
        if method=='POST' and path.endswith('/window') and response[0]==201:
            lookup=path[:-len('/window')]+'/fast-runs/lookup'
            code,fact=super().request(lookup,'POST',dict(input_message_id=body['input_message_id'],
                input_event_id=body['input_event_id']))
            assert code==200,(code,fact)
            assert fact['state']=='succeeded' and fact['acceptance_event_id'] is not None,fact
            result=capture(self.package,fact,self.samples)
            assert result['status']=='observed',result
            accepted=verify(result['receipt_path'],fact,package=self.package)
            assert accepted['status']=='accepted',accepted
            snapshot=json.loads(Path(result['receipt_path']).read_text())
            assert snapshot['launch']['identity']['setup']['role']=='fast'
            assert accepted['native_pid_claim'] is None and not accepted['original_native_pid_registered']
            self.observations.append(dict(receipt_sha256=result['receipt_sha256'],core=fact,snapshot=snapshot,
                accepted=accepted))
        return response

    def run(self):
        report=super().run()
        assert len(self.observations)==3
        assert len({row['core']['run_id'] for row in self.observations})==3
        report.update(fast_sampler_exact_inputs=3,root_live_tree_and_io_observed=True,
            fast_dispatch_states_observed=sorted({row['core']['dispatch_state'] for row in self.observations}),
            native_pid_registration_claimed=False,additional_provider_turns=0,additional_business_messages=0,
            root_module_sha256={name:sha for name,sha in self.package.manifest['files'].items()
                if name.startswith('codex_service/')},
            fixture_scoped_snapshots_verified_before_cleanup=True,fast_observations=self.observations)
        return report


class FastSamplerRehearsal(FastSamplerObservations, FastHostRehearsal):
    def __init__(self, binary):
        super().__init__(binary)
        self.initialize_samples()


class ClaudeFastSamplerRehearsal(FastSamplerObservations, ClaudeFastRehearsal):
    def __init__(self, binary):
        super().__init__(binary)
        self.initialize_samples()


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('binary')
    parser.add_argument('--expected-source',required=True);parser.add_argument('--report',required=True)
    parser.add_argument('--provider',choices=('codex','claude'),default='codex')
    args=parser.parse_args();assert os.geteuid()==0
    identity=json.loads(subprocess.check_output([args.binary,'--version','--json']))
    assert identity.get('source_commit')==args.expected_source,identity
    os.umask(0o077);case=(FastSamplerRehearsal if args.provider=='codex' else ClaudeFastSamplerRehearsal)(args.binary)
    report=dict(passed=False,actual_provider=False,live_activation=False)
    try:report.update(case.run(),passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__,error=str(error),manager_errors=case.pump_errors,
            launch_claims=case.claims(),observations=case.observations)
        if case.process and case.process.stderr:
            os.set_blocking(case.process.stderr.fileno(),False)
            try:report['synthetic_core_stderr']=os.read(case.process.stderr.fileno(),16384).decode(errors='replace')
            except BlockingIOError:pass
        raise
    finally:
        try:case.close();report['cleanup_completed']=True
        finally:
            path=Path(args.report);path.write_text(json.dumps(report,indent=2)+'\n');path.chmod(0o600)
    print(json.dumps(dict(passed=True,fast_exact_inputs=3,native_pid_claim=None,actual_provider=False)))


if __name__=='__main__':main()
