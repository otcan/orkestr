#!/usr/bin/python3
"""Prepare the complete persistent selected Codex release. Never activate it."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from artifact_boundary import separate
from beta_config import validate as validate_beta
from closure import pin, require, trusted
from manager_source import authority
from prepare import inventory, settings
from release import final_bindings, wrapper


def encoded(value):
    return (json.dumps(value,sort_keys=True,indent=2,allow_nan=False)+'\n').encode()


def write(path, data, gid, executable=False, mode=None):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC,0o440)
    with os.fdopen(fd,'wb') as stream:
        os.fchown(stream.fileno(),0,gid);os.fchmod(stream.fileno(),mode if mode is not None else (0o550 if executable else 0o440))
        stream.write(data);stream.flush();os.fsync(stream.fileno())


def directory(path, gid, mode=0o750):
    path.mkdir(mode=mode);os.chown(path,0,gid);path.chmod(mode)


def entry(root, mode):
    require(mode in ('manager','broker'),'fixed entry mode required')
    interpreter=Path('/usr/bin/python3').resolve(strict=True)
    return ('#!/bin/sh\nset -eu\nexec '+shlex.join([str(interpreter),'-I','-S','-B',
            str(root/'codex_service/entry.py'),mode])+' "$@"\n').encode()


def pair_bytes(plan):
    path=Path(plan['pair']);require(pin(path)['sha256']==plan['pair_sha256'],'pair receipt digest mismatch')
    pair=json.loads(path.read_bytes());source=pair['source_commit']
    require(pair['version']=='2.0.0-beta.1' and re.fullmatch('[0-9a-f]{40}',source),'beta source/version required')
    require(pair['server']['profile']=='release' and pair['server']['default_features'] is True and
            pair['server']['features']==[] and pair['web']['profile']=='release' and
            pair['web']['features']==['web','execution-controls'] and
            pair['web']['server_candidate']==source,'same-source release feature profiles required')
    server=Path(plan['server']);ui=Path(plan['ui']);native=Path(plan['native'])
    require(not server.is_symlink() and not native.is_symlink() and not ui.is_symlink(),'artifact aliases refused')
    require(pin(server)['sha256']==pair['server']['sha256'] and
            pin(native)['sha256']==plan['native_sha256'],'artifact digest mismatch')
    require(inventory(ui)==pair['web']['files'],'UI inventory mismatch')
    wasm=list(ui.rglob('*.wasm'));require(len(wasm)==1,'one web WASM required')
    for component,path in (('server',server),('web',wasm[0])):
        blob=path.read_bytes();prefix=b'ORKESTR_V2_BUILD_IDENTITY_V1|'
        record=f'ORKESTR_V2_BUILD_IDENTITY_V1|{component}|2.0.0-beta.1|{source}|END'.encode()
        require(blob.count(prefix)>0 and blob.count(prefix)==blob.count(record),'embedded identity mismatch')
    for path in (server,native):
        blob=path.read_bytes()[:20]
        require(blob[:6]==b'\x7fELF\x02\x01' and blob[18:20]==b'\x3e\x00','Linux x86_64 ELF required')
    return pair


def prepare(plan):
    require(os.geteuid()==0,'root preparation required')
    require(sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode,'use -I -S -B')
    fields={'format','output','source_repository','pair','pair_sha256','server','ui','native','native_sha256',
            'uid','gid','home','workspace','state_root','auth_file','bootstrap_file','ledger_directory',
            'endpoint_directory','owner_id','conversation_id','namespace','supervisor_key','origin','port'}
    require(set(plan)==fields and plan['format']=='orkestr-v2-selected-service-plan-v1','closed plan required')
    separate(plan)  # Metadata only: MUST precede every artifact read/hash.
    pair=pair_bytes(plan);source=pair['source_commit'];gid=plan['gid'];uid=plan['uid']
    require(type(uid) is int and 0<uid<2**31 and type(gid) is int and 0<gid<2**31,'dropped identity required')
    output=Path(plan['output']);inner=output/'package'
    settings(Path(plan['home']),plan['origin'],plan['port'],uid,output,gid)
    require(not output.exists() and not output.is_symlink(),'fresh release required')
    with authority(Path(plan['source_repository']),source) as (src,manager,config):
        trust=sys.modules['codex_bounded.trust']
        trust.protected(output.parent,True)
        # Stat canonical credentials only. Never open, copy or hash these files.
        home=trust.private(plan['home'],uid,True)
        for name in ('data','provider-home'):trust.private(home/name,uid,True)
        trust.private(plan['bootstrap_file'],uid)
        auth=trust.private(plan['auth_file'],uid);require(auth.name=='auth.json','canonical auth reference required')
        workspace=trust.private(plan['workspace'],uid,True)
        account=trust.private(plan['state_root'],uid,True)
        require(not any(workspace.iterdir()) and not any(account.iterdir()),'fresh native state/workspace required')
        ledger=Path(plan['ledger_directory']);endpoint=Path(plan['endpoint_directory'])
        created=[]
        for path,mode in ((ledger,0o700),(endpoint,0o750)):
            require(not path.is_symlink(),'manager alias refused')
            if path.exists():
                trust.protected(path,True)
                require(path.stat().st_gid==gid and path.stat().st_mode&0o777==mode and
                        not any(path.iterdir()),'empty reserved manager directory required')
            else:trust.protected(path.parent,True)
        roots=[output,home,workspace,account,ledger,endpoint,auth,Path(plan['bootstrap_file'])]
        for index,a in enumerate(roots):
            for b in roots[index+1:]:require(a!=b and a not in b.parents and b not in a.parents,'isolated path overlap')
        modules={}
        for folder,names in (('broker',config.BROKER),('isolation',config.ISOLATION),
                             ('codex_bounded',config.MODULES),('codex_service',manager.MODULES_SERVICE)):
            for name in names:
                original=src/('' if folder=='broker' else folder)/name
                modules[folder+'/'+name]=original.read_bytes()
        generated={'server','native','manager.py','launcher.py','service.json','profile.json','beta.json'}
        require(set(modules)|generated==manager.FILES,'authoritative inventory changed; review packager')
        deps={str(Path(p).resolve(strict=True)):pin(trust.protected(Path(p).resolve(strict=True)))['sha256']
              for p in manager.DEPENDENCIES}
        directory(output,gid)
        # No receipt/start-service is published until full Package validation.
        # Remove owned unpublished staging on every ordinary exception.
        try:
            directory(inner,gid)
            for path,mode in ((ledger,0o700),(endpoint,0o750)):
                if not path.exists():directory(path,gid,mode);created.append(path)
            for folder in ('broker','isolation','codex_bounded','codex_service'):directory(inner/folder,gid)
            for name,blob in modules.items():write(inner/name,blob,gid,name=='isolation/supervisor.py')
            for name in ('server','native'):write(inner/name,Path(plan[name]).read_bytes(),gid,True)
            for name,mode in (('manager.py','manager'),('launcher.py','broker')):write(inner/name,entry(inner,mode),gid,True)
            beta={'schema_version':1,'owner_id':plan['owner_id'],'conversation_id':plan['conversation_id'],
                  'manager_socket':str(endpoint/'control.sock'),'launcher':str(inner/'launcher.py'),
                  'launcher_sha256':pin(inner/'launcher.py')['sha256'],'workspace':str(workspace),
                  'namespace':plan['namespace'],'supervisor_key':plan['supervisor_key']}
            validate_beta(encoded(beta))
            runtime={'format':'orkestr-v2-codex-service-v1','uid':uid,'gid':gid,
                     'owner_id':plan['owner_id'],'conversation_id':plan['conversation_id'],'home':str(home),
                     'bootstrap_file':plan['bootstrap_file'],'ledger_directory':str(ledger),
                     'endpoint_directory':str(endpoint),'port':plan['port'],'trusted_origin':plan['origin']}
            profile={'format':'orkestr-v2-codex-isolated-v2','native':str(inner/'native'),
                     'auth_file':str(auth),'state_root':str(account),'workspace':str(workspace),
                     'egress_socket':str(endpoint/'egress.sock'),'supervisor':str(inner/'isolation/supervisor.py'),
                     'hosts':list(config.HOSTS)}
            for name,value in (('beta.json',beta),('service.json',runtime),('profile.json',profile)):
                write(inner/name,encoded(value),gid,mode=0o640 if name=='beta.json' else None)
            directory(inner/'ui',gid)
            for name in pair['web']['files']:
                dest=inner/'ui'/name
                for parent in reversed(dest.parent.parents):
                    if parent.is_relative_to(inner/'ui') and not parent.exists():directory(parent,gid)
                if not dest.parent.exists():directory(dest.parent,gid)
                write(dest,(Path(plan['ui'])/name).read_bytes(),gid)
            require(inventory(inner/'ui')==pair['web']['files'],'copied UI mismatch')
            require(pin(inner/'server')['sha256']==pair['server']['sha256'] and
                    pin(inner/'native')['sha256']==plan['native_sha256'],'copied executable mismatch')
            manifest={'format':'orkestr-v2-codex-service-package-v1','source_commit':source,
                      'files':{name:pin(inner/name)['sha256'] for name in sorted(manager.FILES)},
                      'dependencies':deps,'ui':{name:info['sha256'] for name,info in pair['web']['files'].items()}}
            write(inner/'manifest.json',encoded(manifest),gid);digest=pin(inner/'manifest.json')['sha256']
            manager.Package(inner,digest);final_bindings(inner,inner,gid)
            write(output/'start-service',wrapper(output,Path('/usr/bin/python3').resolve(),digest),gid,True)
            receipt={'format':'orkestr-v2-selected-service-release-v1','source_commit':source,
                     'version':pair['version'],'pair_sha256':plan['pair_sha256'],'native_sha256':plan['native_sha256'],
                     'inner_manifest_sha256':digest,'files':inventory(output),'activated':False,
                     'startup_dependencies':{name:pin(trusted(Path(name).resolve())) for name in ('/bin/sh','/usr/bin/python3')},
                     'credential_contents_read':False,'provider_invoked':False,
                     'transitive_startup_closure_qualified':False,
                     'custody':{str(p.relative_to(output)):{'uid':p.stat().st_uid,'gid':p.stat().st_gid,
                               'mode':p.stat().st_mode&0o777} for p in [output,*output.rglob('*')]}}
            write(output/'release.json',encoded(receipt),gid)
            return {'release':str(output),'receipt_sha256':pin(output/'release.json')['sha256'],
                    'manifest_sha256':digest,'activated':False}
        except BaseException:
            # Remove only owned unpublished staging and newly-created empty manager dirs.
            shutil.rmtree(output)
            for path in reversed(created):
                if path.exists():path.rmdir()
            raise


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--plan',type=Path,required=True)
    try:
        args=p.parse_args();trusted(args.plan)
        require(args.plan.stat().st_size<=32768,'bounded operator plan required')
        print(json.dumps(prepare(json.loads(args.plan.read_bytes()))))
    except Exception:
        sys.stderr.write('persistent selected service preparation refused; no activation\n');sys.exit(2)
