#!/usr/bin/env python3
"""Prepare a fresh persistent HTTP service package; never start or grant execution."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
from urllib.parse import urlsplit

sys.path.insert(0,str(Path(__file__).resolve().parent))
from closure import elf_files, pin, python_files, require
from beta_config import MAX_BETA_CONFIG_BYTES, validate as validate_beta_config


def inventory(root):
    result={}
    for path in sorted(root.rglob('*')):
        require(not path.is_symlink(),'package symlinks refused')
        if path.is_dir():continue
        require(path.is_file(),'regular package files required')
        result[path.relative_to(root).as_posix()]={'sha256':pin(path)['sha256'],'bytes':path.stat().st_size}
    return result


def settings(home, origin, port, uid, package, gid=None):
    home=Path(home);package=Path(package)
    require(home.is_absolute() and package.is_absolute(),'absolute home/package required')
    require(home.resolve()==home and package.resolve()==package,'canonical home/package required')
    require(not home.is_relative_to(package) and not package.is_relative_to(home),'home/package overlap')
    parsed=urlsplit(origin)
    local_origin = origin == f'http://127.0.0.1:{port}'
    require(local_origin or (parsed.scheme=='https' and parsed.hostname and parsed.hostname not in ('0.0.0.0','::','*') and
            not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and
            not parsed.path and parsed.netloc==parsed.hostname),'exact HTTPS origin or matching loopback origin required')
    require(type(port) is int and 1024<=port<=65535,'unprivileged loopback port required')
    require(type(uid) is int and uid>0,'explicit dropped service uid required')
    gid=uid if gid is None else gid
    require(type(gid) is int and gid>0,'explicit dropped service gid required')
    return {'uid':uid,'gid':gid,'home':str(home),'environment':{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8',
            'HOME':str(home),'ORKESTR_V2_HOME':str(home),'ORKESTR_V2_BIND':f'127.0.0.1:{port}',
            'ORKESTR_V2_ORIGIN':origin,'ORKESTR_V2_UI_DIST':str(package/'ui')},
            'secret_transport':{'key':'ORKESTR_V2_BOOTSTRAP_TOKEN','channel':'inherited anonymous pipe FD; no value or digest in plan'},
            'execution':'disabled; manager ABI integration pending explicit reviewed successor'}


def prepare(pair, pair_sha, binary, ui, output, home, origin, port, uid, beta_config=None, gid=None, provisioned_home=False):
    require(pin(pair)['sha256']==pair_sha,'trusted pair receipt digest mismatch')
    value=json.loads(pair.read_text())
    require(value['version']=='2.0.0-beta.1' and re.fullmatch('[0-9a-f]{40}',value['source_commit']), 'exact beta1 source/version required')
    require(value['server']['profile']=='release' and value['web']['profile']=='release','release pair required')
    require(value['server']['default_features'] is True and value['server']['features']==[], 'default native feature profile required')
    require(value['web']['features']==['web','execution-controls'] and value['web']['server_candidate']==value['source_commit'],'same-source controls web required')
    require(not output.exists() and not output.is_symlink(),'fresh package required')
    config=settings(home,origin,port,uid,output,gid)
    require(not binary.is_symlink() and pin(binary)['sha256']==value['server']['sha256'],'server pin mismatch')
    require(inventory(ui)==value['web']['files'],'web inventory mismatch')
    # Byte-only identity check; supplied artifacts are never run during preparation.
    for component,path in [('server',binary),('web',next(iter(sorted(ui.rglob('*.wasm'))),Path('/nonexistent')))]:
        require(component!='web' or len(list(ui.rglob('*.wasm')))==1,'one web WASM required')
        blob=path.read_bytes();prefix=b'ORKESTR_V2_BUILD_IDENTITY_V1|'
        record=f"ORKESTR_V2_BUILD_IDENTITY_V1|{component}|{value['version']}|{value['source_commit']}|END".encode()
        require(blob.count(prefix)>0 and blob.count(prefix)==blob.count(record),'embedded source/version mismatch')
    if provisioned_home:
        st=Path(home).lstat()
        require(stat.S_ISDIR(st.st_mode) and not Path(home).is_symlink() and
                st.st_uid==uid and st.st_gid==config['gid'] and stat.S_IMODE(st.st_mode)==0o700,
                'provisioned isolated home must be private and service-owned')
        config['home_lifecycle']='operator-provisioned; exact setup child stopped/reaped externally; preserve existing state'
    else:
        require(not Path(home).exists() and not Path(home).is_symlink(),'first service package requires fresh isolated home')
        config['home_lifecycle']='fresh; root manager creates private service-owned home'
    if beta_config is not None:
        require(not beta_config.is_symlink(),'beta config symlink refused')
        st=beta_config.stat()
        require(st.st_uid==0 and st.st_gid==config['gid'] and st.st_nlink==1 and (st.st_mode&0o777)==0o640,'root-managed service-group-readable private beta config required')
        require(st.st_size<=MAX_BETA_CONFIG_BYTES,'bounded beta config required')
        validate_beta_config(beta_config.read_bytes())
        config['beta_config']=pin(beta_config)
        config['environment']['ORKESTR_V2_BETA_CONFIG']=str(beta_config.resolve())
        config['execution']='private beta config supplied; manager ABI/runtime qualification separately required'
    dependencies={'server':elf_files(binary),'python':python_files()}
    output.mkdir(mode=0o700)
    try:
        shutil.copyfile(binary,output/'server');(output/'server').chmod(0o500)
        shutil.copytree(ui,output/'ui')
        tools=output/'tools';tools.mkdir()
        for name in ('start.py','closure.py','prepare.py','beta_config.py'):shutil.copyfile(Path(__file__).parent/name,tools/name)
        (output/'paired-artifacts.json').write_bytes(pair.read_bytes())
        require(inventory(output/'ui')==value['web']['files'] and pin(output/'server')['sha256']==value['server']['sha256'],'copied artifact mismatch')
        # A root preparer publishes group-readable files to the dropped service.
        # Unprivileged synthetic preparation only changes its own files.
        for item in [output,*output.rglob('*')]:
            if os.geteuid()==0:os.chown(item,0,config['gid'])
            item.chmod(0o750 if item.is_dir() else (0o550 if item==output/'server' else 0o440))
        dependencies['server']['files'].pop(str(binary.resolve()))
        source_pin=pin(output/'server')
        dependencies['server']['files'][str(output/'server')]=source_pin
        manifest={'format':'orkestr-v2-persistent-service-v1','source_commit':value['source_commit'],
                  'version':value['version'],'files':inventory(output),'settings':config,'dependencies':dependencies,
                  'limits':['HTTP service packaging only; execution manager ABI pending','no service installation or activation','per-host runtime closure; Linux x86_64 only']}
        path=output/'service.json';path.write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n');path.chmod(0o440)
        if os.geteuid()==0:os.chown(path,0,config['gid'])
        return path
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('pair','binary','ui','output','home'):p.add_argument('--'+name,type=Path,required=True)
    for name in ('pair-sha256','origin'):p.add_argument('--'+name,required=True)
    for name in ('port','uid'):p.add_argument('--'+name,type=int,required=True)
    p.add_argument('--beta-config',type=Path)
    p.add_argument('--gid',type=int)
    p.add_argument('--provisioned-home',action='store_true')
    a=p.parse_args();print(prepare(a.pair,a.pair_sha256,a.binary,a.ui,a.output,a.home,a.origin,a.port,a.uid,a.beta_config,a.gid,a.provisioned_home))
