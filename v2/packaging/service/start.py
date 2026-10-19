#!/usr/bin/env python3
"""Root-manager child entry: verify closure as dropped UID, then replace with Rust."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import select
import time
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from closure import pin, require, verify
from prepare import inventory


def startup(plan, digest, secret_fd):
    require(sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode,'use -I -S -B')
    require(pin(plan)['sha256']==digest,'externally trusted service manifest digest required')
    value=json.loads(plan.read_text());root=plan.parent
    require(value['format']=='orkestr-v2-persistent-service-v1','service format mismatch')
    actual=inventory(root);actual.pop('service.json',None)
    require(actual==value['files'],'package inventory changed')
    settings=value['settings'];home=Path(settings['home'])
    require(os.geteuid()==settings['uid'] and os.geteuid()!=0,'root manager must drop uid before service startup')
    require(os.getegid()==settings['gid'],'root manager must drop gid before service startup')
    s=home.lstat();require(home.is_dir() and not home.is_symlink() and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700,'private service-owned isolated home required')
    if 'beta_config' in settings:verify([settings['beta_config']])
    deps=value['dependencies'];verify(deps['server']['files'].values());verify([deps['server']['readelf']])
    verify(deps['python']['files'].values());verify(deps['python']['native'].values())
    require(str(Path(sys.executable).resolve())==deps['python']['executable'],'pinned Python interpreter required')
    require(type(secret_fd) is int and secret_fd>=3 and stat.S_ISFIFO(os.fstat(secret_fd).st_mode),'anonymous pipe secret channel required')
    token=b'';deadline=time.monotonic()+2
    try:
        while len(token)<=4096:
            remaining=deadline-time.monotonic()
            require(remaining>0 and select.select([secret_fd],[],[],remaining)[0],'bootstrap pipe deadline exceeded')
            chunk=os.read(secret_fd,4097-len(token))
            if not chunk:break
            token+=chunk
    finally:os.close(secret_fd)
    require(16<=len(token)<=4096 and b'\x00' not in token and b'\n' not in token,'bounded bootstrap token required')
    environment=dict(settings['environment']);environment['ORKESTR_V2_BOOTSTRAP_TOKEN']=token.decode('ascii')
    lock=os.open(home/'.service.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        st=os.fstat(lock)
        require(stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600,'private service lock required')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        os.set_inheritable(lock,True)
        for item in Path('/proc/self/fd').iterdir():
            fd=int(item.name)
            if fd>2 and fd!=lock:
                try:os.close(fd)
                except OSError:pass
    except BaseException:
        os.close(lock);raise
    return [str(root/'server')],environment


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--plan',type=Path,required=True);p.add_argument('--sha256',required=True);p.add_argument('--bootstrap-fd',type=int,required=True)
    a=p.parse_args();argv,env=startup(a.plan,a.sha256,a.bootstrap_fd);os.execve(argv[0],argv,env)
