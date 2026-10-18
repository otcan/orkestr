#!/usr/bin/env python3
"""Opt-in isolated persistent foreground lifecycle; never installs a host service.

Start requires a candidate-stage release packet. Monitoring attaches only to the
exact child launched here. Neither command activates providers or live routing.
"""
import argparse
import json
import os
import stat
from pathlib import Path
import signal
import subprocess
import sys
import time

import attended
import package_candidate
import receipt
import prerequisites
import segments
import soak
from install_state import config, fresh_path, private_home, write_json
from launcher import release


def identity(plan):
    candidate=Path(plan['candidate']);home=private_home(Path(plan['home']))
    manifest=package_candidate.verify(candidate)
    receipt.require(receipt.sha(candidate/'candidate.json')==plan['candidate_artifact_sha256'], 'candidate changed')
    receipt.require(receipt.sha(home/'install.json')==plan['install_sha256'], 'installed configuration changed')
    receipt.require(manifest['source_commit']==plan['revision'], 'revision changed')
    _,installed,_=release(home)
    receipt.require(receipt.sha(installed/'manifest.json')==receipt.sha(candidate/'native/manifest.json'), 'installed release differs from candidate')
    return {key:plan[key] for key in segments.KEYS}


def prepare(candidate, home, plan_path, port):
    candidate=candidate.resolve();manifest=package_candidate.verify(candidate)
    home=fresh_path(home,[candidate]);plan_path=fresh_path(plan_path,[candidate,home])
    configuration_path=fresh_path(plan_path.with_name(plan_path.name+'.configuration.json'),[candidate,home,plan_path])
    attended.invoke(candidate/'native/bin/orkestr-v2','install',home,'--package',candidate/'native','--port',port)
    value={'format':'orkestr-v2-persistent-plan-v1','candidate':str(candidate),'home':str(home),
           'revision':manifest['source_commit'],'candidate_artifact_sha256':receipt.sha(candidate/'candidate.json'),
           'install_sha256':receipt.sha(home/'install.json'),'port':port,
           'providers':'none','routing':'unconfigured','lifecycle':'foreground_owned_child'}
    configuration=json.dumps(value,sort_keys=True,separators=(',', ':'))
    with open(configuration_path,'x',opener=lambda path,flags:os.open(path,flags,0o600)) as stream:
        stream.write(configuration)
    value['configuration_sha256']=receipt.digest(value)
    write_json(plan_path,value)
    return value


def load(path):
    receipt.require(path.is_absolute() and not path.is_symlink(), 'absolute regular private plan required')
    metadata=path.lstat()
    receipt.require(stat.S_ISREG(metadata.st_mode),'regular private plan required')
    receipt.require(metadata.st_uid==os.getuid() and metadata.st_mode&0o077==0,'private owned plan required')
    plan=json.loads(path.read_text())
    receipt.require(plan['format']=='orkestr-v2-persistent-plan-v1','unsupported plan')
    expected=plan.pop('configuration_sha256')
    receipt.require(receipt.digest(plan)==expected,'plan configuration changed')
    plan['configuration_sha256']=expected
    receipt.require(config(private_home(Path(plan['home'])))['port']==plan['port'],'port changed')
    identity(plan)
    return plan


def candidate_gate(plan, validator, evidence, scope, artifacts):
    # Use the canonical validator; never manufacture a gate receipt or bypass it.
    result=subprocess.run([sys.executable,'-B',str(validator),str(evidence),'--scope',str(scope),
        '--artifact-root',str(artifacts),'--revision',plan['revision'],'--require','candidate'],
        capture_output=True,text=True,timeout=60)
    receipt.require(result.returncode==0,'candidate gates failed; start refused')
    report=json.loads(result.stdout)
    receipt.require(report.get('ready') is True and report.get('candidate_revision')==plan['revision'], 'candidate gate identity mismatch')
    packet=json.loads(evidence.read_text())
    selected=packet.get('candidate',{})
    receipt.require(selected.get('artifact',{}).get('sha256')==plan['candidate_artifact_sha256'], 'candidate gate artifact mismatch')
    receipt.require(selected.get('configuration',{}).get('sha256')==plan['configuration_sha256'], 'candidate gate configuration mismatch')
    manifest=package_candidate.verify(Path(plan['candidate']))
    receipt.require(selected.get('version')==manifest['version'], 'candidate gate version mismatch')
    return {name:receipt.sha(path) for name,path in [('validator',validator),('evidence',evidence),('scope',scope)]}


def serve(plan, gate, journal_dir=None, samples=2, interval=1, latency=1000, rss=1024**3):
    attended.bounds(samples,interval,latency,rss,True)
    identity(plan)
    home=Path(plan['home']);candidate=Path(plan['candidate']);entry=candidate/'native/bin/orkestr-v2'
    journal=None;process=None;clean=False
    def monitoring_identity():
        value=dict(identity(plan))
        value['configuration_sha256']=receipt.digest({'plan':value['configuration_sha256'],
            'gate_input_sha256':gate,'interval':interval,'max_latency_ms':latency,
            'max_rss_bytes':rss,'samples':samples,'segment_seconds':300})
        return value
    try:
        if journal_dir is not None:
            journal_dir=fresh_path(journal_dir,[home,candidate])
            journal=segments.Journal(journal_dir,monitoring_identity())
            # Explicitly not a qualifying production window: candidate gates alone
            # do not certify daily-use behavior, routing or final release gates.
            journal.state['environment']='controlled_project_owned'
            journal.state['gate_input_sha256']=gate;journal.persist()
        with (home/'logs/persistent.log').open('ab') as log:
            process=attended.launch(entry,home,attended.Client(plan['port']),log)
            index=0
            while journal is None or index<samples:
                receipt.require(process.poll() is None,'persistent owned launcher exited')
                if 'execution_dependencies' in gate:
                    receipt.require(prerequisites.trusted_binary()==gate['execution_dependencies']['bwrap'], 'execution dependency changed')
                current=monitoring_identity()
                health=soak.measure('http://127.0.0.1:'+str(plan['port']),1,0,2,latency)
                resource=attended.resources(process.pid)
                receipt.require(health['latency_threshold_passed'] and resource['rss_bytes']<=rss,'health/resource threshold failed')
                if journal is not None:journal.observe({'index':index,'health':health,'resources':resource},current)
                index+=1
                if journal is None or index<samples:time.sleep(interval)
    except BaseException:
        if journal is not None:journal.incident('persistent_monitor_interruption_or_failure')
        raise
    finally:
        try:
            if process is not None:attended.stop_owned(process)
            clean=True
        finally:
            if journal is not None:journal.finish(clean)
    # Persistent home and its logs are deliberately retained, including on failure.


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--plan',type=Path,required=True)
    sub=p.add_subparsers(dest='command',required=True)
    install=sub.add_parser('prepare');install.add_argument('--candidate',type=Path,required=True)
    install.add_argument('--home',type=Path,required=True);install.add_argument('--port',type=int,required=True)
    start=sub.add_parser('start')
    for name in ('validator','evidence','scope','artifact-root'):start.add_argument('--'+name,type=Path,required=True)
    start.add_argument('--journal-dir',type=Path);start.add_argument('--samples',type=int,default=2)
    start.add_argument('--interval',type=float,default=1);start.add_argument('--max-latency-ms',type=float,required=True)
    start.add_argument('--max-rss-bytes',type=int,required=True)
    for command in ('health','logs','stop','backup'):
        item=sub.add_parser(command)
        if command=='backup':item.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    if a.command=='prepare':prepare(a.candidate,a.home,a.plan,a.port);return
    plan=load(a.plan);entry=Path(plan['candidate'])/'native/bin/orkestr-v2';home=Path(plan['home'])
    if a.command=='start':
        dependencies=prerequisites.check()
        gate=candidate_gate(plan,a.validator,a.evidence,a.scope,a.artifact_root)
        gate['execution_dependencies']=dependencies
        serve(plan,gate,a.journal_dir,a.samples,a.interval,a.max_latency_ms,a.max_rss_bytes)
    else:
        command='doctor' if a.command=='health' else a.command
        extra=['--health'] if a.command=='health' else ['--output',a.output] if a.command=='backup' else []
        print(attended.invoke(entry,command,home,*extra).stdout,end='')


if __name__=='__main__':
    def interrupted(signum,frame):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,interrupted)
    main()
