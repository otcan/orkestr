"""Closed generated Claude state; only project transcripts enter the next process."""
import os
from pathlib import Path
import re
import stat
import uuid
from .authenticated import private_path


def state_root(path):
    root=Path(private_path(path,True))
    directories={'projects','sessions','backups','telemetry'}
    files={'.claude.json','policy-limits.json','policy-limits.json.stamp.json','remote-settings.json'}
    count=0;total=0
    for item in root.iterdir():
        if item.name not in directories|files:raise ValueError('unexpected Claude state')
        if item.name in directories and not item.is_dir():raise ValueError('Claude state type')
        if item.name in files and not item.is_file():raise ValueError('Claude state type')
    for directory,folders,files in os.walk(root,followlinks=False):
        for name in folders+files:
            item=Path(directory)/name;info=item.lstat();count+=1;total+=info.st_size
            if count>10000 or total>256*1024**2:raise ValueError('Claude state bound')
            if info.st_uid not in (0,os.geteuid()) or info.st_mode & 0o022:
                raise ValueError('unsafe Claude state')
            relative=item.relative_to(root).parts
            if len(relative)>1:
                top=relative[0]
                if top=='projects':
                    if len(relative)>3 or (len(relative)==2 and not stat.S_ISDIR(info.st_mode)):
                        raise ValueError('Claude project layout')
                    if len(relative)==3 and not stat.S_ISREG(info.st_mode):
                        raise ValueError('Claude transcript type')
                elif top=='backups':
                    if not stat.S_ISREG(info.st_mode):raise ValueError('Claude backup type')
                    if len(relative)!=2 or not re.fullmatch(r'\.claude\.json\.backup\.[0-9]{1,20}',name):
                        raise ValueError('Claude backup layout')
                elif top=='telemetry':
                    if not stat.S_ISREG(info.st_mode):raise ValueError('Claude telemetry type')
                    if len(relative)!=2 or not re.fullmatch(r'1p_failed_events\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.json',name):
                        raise ValueError('Claude telemetry layout')
                else:raise ValueError('unexpected Claude nested state')
            if stat.S_ISREG(info.st_mode):
                if info.st_nlink!=1:raise ValueError('Claude state hardlink')
                limit=64*1024**2 if relative[0]=='projects' else 8*1024**2
                if info.st_size>limit:raise ValueError('Claude file bound')
            elif not stat.S_ISDIR(info.st_mode):raise ValueError('Claude state alias/type')
    return str(root)


def projects(root,workspace,native=None,*,fresh=False):
    state_root(root)
    path=Path(root)/'projects'
    if not path.exists():path.mkdir(mode=0o700)
    expected=re.sub(r'[^a-zA-Z0-9]','-',str(workspace))
    for project in path.iterdir():
        if project.name!=expected or not project.is_dir():raise ValueError('foreign Claude workspace')
        for entry in project.iterdir():
            if fresh:raise ValueError('fresh Claude setup cannot adopt transcript')
            if not entry.is_file() or entry.suffix!='.jsonl':raise ValueError('unexpected Claude transcript')
            if str(uuid.UUID(entry.stem))!=entry.stem:raise ValueError('invalid Claude session')
            if native is not None and entry.stem!=native:raise ValueError('foreign Claude session')
    if native is not None and not (path/expected/(native+'.jsonl')).is_file():
        raise ValueError('missing Claude resume transcript')
    return str(path)
