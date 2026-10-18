#!/usr/bin/env python3
"""Finite fresh-state native supervisor; never attaches to an existing server.

Linux only. No providers, recurring jobs, production state or schema upgrades.
SIGINT/termination always attempts to stop the exact child created here.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import time
import package_candidate
import receipt
import soak
import segments

LOCAL=Path(__file__).resolve().parents[2]/'local-install'
sys.path.insert(0,str(LOCAL/'tests'))
from real_package import Client,invoke,launch,stop_owned,smoke,verify_history


def resources(group):
    """Aggregate this launcher's dedicated process group; read-only /proc access."""
    rows=[]
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():continue
        try:
            fields=(directory/'stat').read_text().rsplit(')',1)[1].split()
            if int(fields[2]) != group:continue
            pages=int((directory/'statm').read_text().split()[1])
            rows.append(pages*os.sysconf('SC_PAGE_SIZE'))
        except (FileNotFoundError,ProcessLookupError):continue
    receipt.require(rows,'owned process group disappeared')
    return {'processes':len(rows),'rss_bytes':sum(rows)}


def bounds(samples,interval,latency,rss,segmented=False):
    cap=259200 if segmented else 600
    receipt.require(2 <= samples <= cap and 0 <= interval <= 5 and samples*interval <= cap,
                    'bounded 2..600 samples and at most 600 seconds spacing required')
    receipt.require(0 < latency <= 10000 and 0 < rss <= 16*1024**3,'explicit bounded latency/resource limits required')


def finish_home(root,passed,journal):
    if passed:
        try:shutil.rmtree(root)
        except BaseException:
            if journal is not None:journal.finish(False)
            raise
    else:print('Failed private attended probe retained: '+str(root),file=sys.stderr)
    # A passing journal certifies both child termination and owned-home removal.
    if journal is not None:journal.finish(passed)


def exercise(candidate,parent,port,samples,interval,max_latency_ms,max_rss_bytes,restart=False,journal_dir=None,segment_seconds=300):
    bounds(samples,interval,max_latency_ms,max_rss_bytes,journal_dir is not None)
    receipt.require(sys.platform=='linux','Linux /proc required')
    manifest=package_candidate.verify(candidate)
    receipt.require(parent.is_absolute() and parent.is_dir(),'existing private parent required')
    if journal_dir is not None:
        from install_state import fresh_path
        journal_dir=fresh_path(journal_dir,[candidate,LOCAL])
    root=Path(tempfile.mkdtemp(prefix='v2-attended-',dir=parent));root.chmod(0o700)
    home=root/'home';entry=candidate/'native/bin/orkestr-v2';process=None;passed=False
    rows=[];events=[];journal=None
    try:
        invoke(entry,'install',home,'--package',candidate/'native','--port',port)
        with (root/'private.log').open('wb') as log:
            client=Client(port);process=launch(entry,home,client,log)
            path,admission,message=smoke(client,(home/'control/bootstrap.token').read_text())
            def identity():
                package_candidate.verify(candidate)
                return {'revision':manifest['source_commit'],
                        'candidate_artifact_sha256':receipt.sha(candidate/'candidate.json'),
                        'configuration_sha256':receipt.digest({'install_sha256':receipt.sha(home/'install.json'),
                            'port':port,'max_latency_ms':max_latency_ms,'max_rss_bytes':max_rss_bytes,
                            'interval':interval,'segment_seconds':segment_seconds,'providers':'none'})}
            if journal_dir is not None:
                journal=segments.Journal(journal_dir,identity(),segment_seconds,max(10,interval+5))
            started=time.monotonic()
            for index in range(samples):
                receipt.require(process.poll() is None,'owned launcher exited unexpectedly')
                if restart and index==samples//2:
                    if journal is not None:journal.restart()
                    before=time.monotonic()
                    invoke(entry,'stop',home)
                    receipt.require(process.wait(timeout=10)==0,'owned stop failed');process=None
                    process=launch(entry,home,client,log)
                    verify_history(client,path,admission,message)
                    events.append({'kind':'graceful_restart_history_verified','offset_ms':round((before-started)*1000,3),
                                   'recovery_ms':round((time.monotonic()-before)*1000,3)})
                health=soak.measure(client.base.removesuffix('/api/v2'),1,0,2,max_latency_ms)
                resource=resources(process.pid)
                row={'index':index,'offset_ms':round((time.monotonic()-started)*1000,3),
                     'health':health,'resources':resource}
                if journal is None:rows.append(row)
                else:journal.observe(row,identity())
                receipt.require(health['successes']==1 and health['latency_threshold_passed'],'health/latency threshold failed')
                receipt.require(resource['rss_bytes']<=max_rss_bytes,'owned process group RSS threshold exceeded')
                if index+1<samples:time.sleep(interval)
            duration=round((time.monotonic()-started)*1000,3)
            invoke(entry,'stop',home);receipt.require(process.wait(timeout=10)==0,'final owned stop failed');process=None
        passed=True
    except BaseException:
        if journal is not None:journal.incident('supervisor_failure_or_interruption')
        raise
    finally:
        if process is not None:
            try:stop_owned(process)
            except BaseException:
                if journal is not None:journal.finish(False)
                raise
        finish_home(root,passed,journal)
    return {'status':'passed','source_commit':manifest['source_commit'],'candidate_manifest_sha256':receipt.sha(candidate/'candidate.json'),
            'scope':'finite attended synthetic native nonprovider probe; production soak window not started',
            'limits':{'max_latency_ms':max_latency_ms,'max_rss_bytes':max_rss_bytes},
            'monitor_window':None if journal is None else journal.state,
            'duration_ms':duration,'samples':rows,'events':events,'owned_home_removed':not root.exists(),
            'unexecuted':['Crash recovery','Session revocation','Providers','Browser interaction','Production soak','Executor isolation'],
            'resource_limits':'RSS sums may double-count shared pages; excludes external services; not a leak or capacity certification'}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('candidate','parent'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--port',type=int,required=True);p.add_argument('--samples',type=int,required=True)
    p.add_argument('--interval',type=float,default=1);p.add_argument('--max-latency-ms',type=float,required=True)
    p.add_argument('--max-rss-bytes',type=int,required=True);p.add_argument('--restart',action='store_true')
    p.add_argument('--journal-dir',type=Path,help='Fresh segmented journal; never resumes a prior window')
    p.add_argument('--segment-seconds',type=int,default=300)
    p.add_argument('--output',required=True);a=p.parse_args()
    def interrupted(signum,frame):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,interrupted)
    with open(a.output,'x') as stream:
        json.dump(exercise(a.candidate,a.parent,a.port,a.samples,a.interval,a.max_latency_ms,a.max_rss_bytes,a.restart,a.journal_dir,a.segment_seconds),stream,indent=2,sort_keys=True)
        stream.write('\n')
