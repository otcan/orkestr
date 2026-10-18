"""Durable observation segments for the existing owned supervisor, not a scheduler.

Never resumes or joins prior windows. Failed/stopped monitors need a new window.
Records hashes only for configuration; never configuration contents or credentials.
"""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time

KEYS=('revision','candidate_artifact_sha256','configuration_sha256')


def utc():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')


def timestamp(value):
    result=datetime.fromisoformat(value)
    if result.tzinfo is None:raise RuntimeError('timezone required')
    return result


def validate(value):
    if value.get('status')!='passed' or value.get('incidents') or value.get('material_fixes'):
        raise RuntimeError('incident/change requires new window')
    for key,size in zip(KEYS,(40,64,64)):
        if not re.fullmatch('[0-9a-f]{'+str(size)+'}',value.get(key,'')):
            raise RuntimeError('exact identity required')
    cursor=timestamp(value['started_at'])
    if not value['segments']:raise RuntimeError('no observed segments')
    for segment in value['segments']:
        if any(segment.get(k)!=value[k] for k in KEYS):raise RuntimeError('identity change requires reset')
        start,end=timestamp(segment['started_at']),timestamp(segment['completed_at'])
        if start!=cursor:raise RuntimeError('discontinuity: gap or overlap')
        if not 0<(end-start).total_seconds()<=3600:raise RuntimeError('segment must be <=1h')
        if segment.get('status')!='passed':raise RuntimeError('segment incident')
        cursor=end
    if cursor!=timestamp(value['completed_at']):raise RuntimeError('incomplete coverage')
    return value


class Journal:
    def __init__(self,directory,identity,segment_seconds=300,max_gap_seconds=10):
        if not 1<=segment_seconds<=3500 or not 0<max_gap_seconds<=60:
            raise RuntimeError('bounded segment/gap policy required')
        self.directory=Path(directory);self.directory.mkdir(mode=0o700)  # Never overwrite/resume.
        self.identity=dict(identity);self.seconds=segment_seconds;self.max_gap=max_gap_seconds
        now=utc();self.start_mono=self.last_mono=self.boundary_mono=time.monotonic()
        self.state={**identity,'format':'orkestr-v2-monitor-window-v1','environment':'synthetic_owned',
                    'status':'observing','started_at':now,'completed_at':None,
                    'incidents':0,'material_fixes':0,'segments':[], 'events':[]}
        self.boundary=now;self.last_utc=now;self.closed=False;self.persist()

    def persist(self):
        # Atomic state replace; fsync records before declaring progress.
        import os
        temporary=self.directory/'window.pending'
        with temporary.open('w') as stream:
            json.dump(self.state,stream,sort_keys=True,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
        temporary.replace(self.directory/'window.json')

    def incident(self,kind,material=False):
        self.state['status']='invalidated'
        self.state['incidents']+=1;self.state['material_fixes']+=int(material)
        self.state['events'].append({'kind':kind,'observed_at':utc(),'requires_new_window':True})
        self.persist()

    def observe(self,row,identity):
        import os
        now=utc();mono=time.monotonic()
        if self.closed or self.state['status']!='observing':raise RuntimeError('window invalidated/closed')
        if identity!=self.identity:
            self.incident('artifact_or_configuration_change',True);raise RuntimeError('identity changed; new window required')
        wall=(timestamp(now)-timestamp(self.state['started_at'])).total_seconds()
        if mono-self.last_mono>self.max_gap or abs(wall-(mono-self.start_mono))>2:
            self.incident('observation_gap_or_clock_change');raise RuntimeError('observation discontinuity')
        with (self.directory/'samples.jsonl').open('a') as stream:
            stream.write(json.dumps({'observed_at':now,**row},sort_keys=True)+'\n');stream.flush();os.fsync(stream.fileno())
        self.last_mono=mono;self.last_utc=now
        if mono-self.boundary_mono>=self.seconds:self.segment(now,mono)

    def segment(self,now,mono):
        if timestamp(now)<=timestamp(self.boundary):return
        self.state['segments'].append({**self.identity,'started_at':self.boundary,'completed_at':now,'status':'passed'})
        self.boundary=now;self.boundary_mono=mono;self.state['completed_at']=now;self.persist()

    def restart(self):
        # Downtime is an incident for an uninterrupted window, even if planned.
        self.incident('graceful_restart')

    def finish(self,cleanup_ok):
        if not cleanup_ok:self.incident('owned_cleanup_failed')
        if self.state['status']=='observing':
            now=utc();mono=time.monotonic()
            if mono-self.last_mono>self.max_gap:self.incident('final_observation_gap')
            else:
                self.segment(self.last_utc,self.last_mono);self.state['status']='passed';self.persist()
                validate(self.state)
        self.closed=True
        return self.state
