#!/usr/bin/python3
"""Prepare the complete persistent selected Codex release. Never activate it."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from artifact_boundary import separate
from beta_config import (validate as validate_beta, workspace_exec as validate_workspace_exec,
                         additional_workspace_exec as validate_additional_workspace_exec, window_lifetimes,
                         conversation_workspaces as validate_conversation_workspaces,
                         host_full_access as validate_host_full_access)
from closure import pin, require, trusted
from manager_source import authority
from prepare import inventory, settings
from release import final_bindings, wrapper
import selected_roles


def encoded(value):
    return (json.dumps(value,sort_keys=True,indent=2,allow_nan=False)+'\n').encode()


def write(path, data, gid, executable=False, mode=None):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC,0o440)
    with os.fdopen(fd,'wb') as stream:
        os.fchown(stream.fileno(),0,gid);os.fchmod(stream.fileno(),mode if mode is not None else (0o550 if executable else 0o440))
        stream.write(data);stream.flush();os.fsync(stream.fileno())


def host_machine():
    """ELF e_machine every selected artifact must carry: exactly this host's."""
    machines={'x86_64':b'\x3e\x00','aarch64':b'\xb7\x00'}
    require(platform.machine() in machines,'Linux x86_64 or aarch64 host required')
    return machines[platform.machine()]


def directory(path, gid, mode=0o750):
    path.mkdir(mode=mode);os.chown(path,0,gid);path.chmod(mode)


def entry(root, mode):
    require(mode in ('manager','broker','broker-claude', *('broker-' + role for role in selected_roles.NAMES)),
            'fixed entry mode required')
    interpreter=Path('/usr/bin/python3').resolve(strict=True)
    return ('#!/bin/sh\nset -eu\nexec '+shlex.join([str(interpreter),'-I','-S','-B',
            str(root/'codex_service/entry.py'),mode])+' "$@"\n').encode()


def pair_bytes(plan):
    path=Path(plan['pair']);require(pin(path)['sha256']==plan['pair_sha256'],'pair receipt digest mismatch')
    pair=json.loads(path.read_bytes());source=pair['source_commit']
    require(pair['version'] in ('2.0.0-beta.1','2.0.0-beta.2','2.0.0-beta.3','2.0.0-beta.4','2.0.0-beta.5','2.0.0-beta.6') and re.fullmatch('[0-9a-f]{40}',source),'beta source/version required')
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
        record=f"ORKESTR_V2_BUILD_IDENTITY_V1|{component}|{pair['version']}|{source}|END".encode()
        require(blob.count(prefix)>0 and blob.count(prefix)==blob.count(record),'embedded identity mismatch')
    artifacts=[server,native]
    if 'code_mode_host' in plan:
        host=Path(plan['code_mode_host'])
        require(not host.is_symlink() and pin(host)['sha256']==plan['code_mode_host_sha256'],
                'artifact digest mismatch')
        artifacts.append(host)
    for path in artifacts:
        blob=path.read_bytes()[:20]
        require(blob[:6]==b'\x7fELF\x02\x01' and blob[18:20]==host_machine(),'native Linux ELF for this host required')
    return pair


OPTIONAL = {'roles', 'preserve_state', 'workspace_exec', 'additional_workspace_exec', 'max_active_windows', 'host_full_access',
            'window_max_minutes', 'conversation_window_max_minutes', 'conversation_workspaces',
            'code_mode_host', 'code_mode_host_sha256', 'claude', 'claude_quota_projection', 'codex_quota_projection', 'live_map', 'desktop_broker', 'timer_config', 'whatsapp_chats', 'v1_chat_icons_dir', 'metrics_port'}
CLAUDE_PATHS = ('executable', 'account', 'workspace', 'home', 'temporary')
# Account selection stays with the Claude account reference, never the env.
CLAUDE_FORBIDDEN_ENV = {'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
                        'CLAUDE_CONFIG_DIR'}


def claude_inventory(manager):
    # Keep a closed, reviewed inventory. Counting files alone missed the new
    # policy codec at preparation time even though the manager required it.
    expected = {'launcher-claude.py', 'claude-private.json'} | {
        'broker/' + name for name in ('claude_connector.py', 'claude_protocol.py', 'claude_control.py',
                                     'claude_telemetry.py', 'claude_quota.py', 'claude_resume.py', 'claude_bootstrap.py',
                                     'claude_policy.py', 'startup_diagnostics.py')}
    files = set(getattr(manager, 'CLAUDE_FILES', set()))
    require(files == expected, 'manager Claude inventory required')
    return files


def claude(plan):
    """Optional Claude Deep/Fast window runtime; requires host full access."""
    value = plan['claude']
    require(type(value) is dict and set(value) - {'default', 'fast'} == set(CLAUDE_PATHS)
            and all(type(value.get(k, False)) is bool for k in ('default', 'fast')),
            'closed Claude plan required')
    require(all(type(value[k]) is str and value[k].startswith('/') and '\x00' not in value[k]
                and '..' not in Path(value[k]).parts for k in CLAUDE_PATHS), 'absolute Claude paths required')
    access = plan.get('host_full_access')
    require(type(access) is dict, 'Claude windows require host_full_access')
    require(not CLAUDE_FORBIDDEN_ENV & set(access['environment']),
            'host environment must not select a Claude account')
    return value


def optional(plan):
    """Shape of the optional plan extensions copied into the protected beta config."""
    if 'workspace_exec' in plan:
        require('roles' in plan, 'workspace execution requires configured Worker roles')
        validate_workspace_exec(plan['workspace_exec'])
    if 'host_full_access' in plan:
        # Operator opt-in equivalent to host root; never derived from HTTP or model input.
        validate_host_full_access(plan['host_full_access'])
    # Host natives start Codex's code-mode host (dynamic tools) from their own
    # directory: the same-release binary is pinned beside the native.
    host_providers = plan.get('host_full_access', {}).get('providers', True) is True \
        if 'host_full_access' in plan else False
    require(('code_mode_host' in plan) == ('code_mode_host_sha256' in plan) == host_providers,
            'host_full_access providers require exactly one pinned code_mode_host')
    if 'code_mode_host' in plan:
        require(type(plan['code_mode_host']) is str and plan['code_mode_host'].startswith('/')
                and type(plan['code_mode_host_sha256']) is str
                and re.fullmatch('[0-9a-f]{64}', plan['code_mode_host_sha256']),
                'pinned code_mode_host required')
    if 'claude' in plan:
        claude(plan)
    for key,label in (('claude_quota_projection','Claude'),('codex_quota_projection','Codex')):
        if key not in plan:
            continue
        import uuid
        value=plan[key]
        require((key!='claude_quota_projection' or 'claude' in plan) and type(value) is dict
                and set(value)=={'directory','account_ref'}
                and type(value['directory']) is str and value['directory'].startswith('/')
                and len(value['directory'])<=4096 and '\x00' not in value['directory']
                and '..' not in Path(value['directory']).parts
                and type(value['account_ref']) is str and str(uuid.UUID(value['account_ref']))==value['account_ref']
                and uuid.UUID(value['account_ref']).int != 0,
                f'closed passive {label} quota projection required')
    privileged = plan.get('workspace_exec', {}).get('trusted', {}).get('host_privileged') is True
    require(not privileged or 'host_full_access' in plan,
            'host-privileged commands require host_full_access')
    window_lifetimes(plan)
    validate_conversation_workspaces(plan)
    if 'additional_workspace_exec' in plan:
        require('roles' in plan, 'workspace execution requires configured Worker roles')
        validate_additional_workspace_exec(plan)


def prepare(plan):
    require(os.geteuid()==0,'root preparation required')
    require(sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode,'use -I -S -B')
    fields={'format','output','source_repository','pair','pair_sha256','server','ui','native','native_sha256',
            'uid','gid','home','workspace','state_root','auth_file','bootstrap_file','ledger_directory',
            'endpoint_directory','owner_id','conversation_id','namespace','supervisor_key','origin','port'}
    require(set(plan) - OPTIONAL == fields and
            plan['format']=='orkestr-v2-selected-service-plan-v1','closed plan required')
    optional(plan)
    if 'live_map' in plan:
        # Opt-in read-only live map file; the server reads it, the packager never does.
        live=plan['live_map']
        require(type(live) is str and live.startswith('/') and 1<len(live)<=4096 and '\0' not in live
                and '..' not in Path(live).parts and not any(ord(c)<32 for c in live),'live map path')
    if 'v1_chat_icons_dir' in plan:
        # Read-only V1 chat icon directory: path only, never read by the packager.
        icons=plan['v1_chat_icons_dir']
        require(type(icons) is str and icons.startswith('/') and 1<len(icons)<=4096 and '\0' not in icons
                and '..' not in Path(icons).parts and not any(ord(c)<32 for c in icons),'v1 chat icons path')
    if 'metrics_port' in plan:
        require(type(plan['metrics_port']) is int and 1024<=plan['metrics_port']<=65535
                and plan['metrics_port']!=plan['port'],'metrics port refused')
    if 'timer_config' in plan:
        # Private durable-timer scheduler config (names the machine token
        # file): path only, never opened by the packager; the server validates it.
        timer=plan['timer_config']
        require(type(timer) is str and timer.startswith('/') and 1<len(timer)<=4096 and '\0' not in timer
                and '..' not in Path(timer).parts and not any(ord(c)<32 for c in timer),'timer config path')
    if 'desktop_broker' in plan:
        # Private V1 desktop broker client file (holds a V1 token): path only,
        # never opened or hashed by the packager; the server validates it.
        broker=plan['desktop_broker']
        require(type(broker) is str and broker.startswith('/') and 1<len(broker)<=4096 and '\0' not in broker
                and '..' not in Path(broker).parts and not any(ord(c)<32 for c in broker),'desktop broker path')
    if 'whatsapp_chats' in plan:
        # Private "New WhatsApp chat" file (adapter token, owner numbers): path
        # only, never opened or hashed by the packager; the server validates it.
        chats=plan['whatsapp_chats']
        require(type(chats) is str and chats.startswith('/') and 1<len(chats)<=4096 and '\0' not in chats
                and '..' not in Path(chats).parts and not any(ord(c)<32 for c in chats),'whatsapp chats path')
    preserve=plan.get('preserve_state',False)
    require(type(preserve) is bool,'explicit preserve_state boolean required')
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
        require(preserve or (not any(workspace.iterdir()) and not any(account.iterdir())),
                'fresh native state/workspace required')
        ledger=Path(plan['ledger_directory']);endpoint=Path(plan['endpoint_directory'])
        created=[]
        for path,mode in ((ledger,0o700),(endpoint,0o750)):
            require(not path.is_symlink(),'manager alias refused')
            if path.exists():
                trust.protected(path,True)
                require(path.stat().st_gid==gid and path.stat().st_mode&0o777==mode and
                        (preserve or not any(path.iterdir())),'empty reserved manager directory required')
            else:trust.protected(path.parent,True)
        roots=[output,home,workspace,account,ledger,endpoint,auth,Path(plan['bootstrap_file'])]
        for index,a in enumerate(roots):
            for b in roots[index+1:]:require(a!=b and a not in b.parents and b not in a.parents,'isolated path overlap')
        role_paths = selected_roles.validate(plan['roles'],trust,uid,roots,preserve) if 'roles' in plan else None
        for command in ([plan['workspace_exec']] if 'workspace_exec' in plan else [])+plan.get('additional_workspace_exec',[]):
            project = trust.private(command['workspace'],uid,True)
            isolated = [*roots, *(p for pair in role_paths.values() for p in pair)]
            for other in isolated:
                require(project != other and project not in other.parents and other not in project.parents,
                        'project must be separate from provider and service state')
        role_files = getattr(manager,'ROLE_FILES',set()) if role_paths is not None else set()
        require(role_paths is None or len(role_files)==10,'manager role inventory required')
        host_files = set(getattr(manager,'HOST_FILES',set())) if 'code_mode_host' in plan else set()
        require(not host_files or host_files == {'codex-code-mode-host'},'manager host inventory required')
        claude_plan = plan.get('claude')
        claude_files = claude_inventory(manager) if claude_plan else set()
        if claude_plan:
            # Paths only: the account directory is never opened, listed or hashed.
            require(Path(claude_plan['executable']).resolve(strict=True)==Path(claude_plan['executable'])
                    and Path(claude_plan['executable']).is_file()
                    and Path(claude_plan['account']).resolve(strict=True)==Path(claude_plan['account']),
                    'canonical Claude executable and account required')
            claude_dirs=[trust.private(claude_plan[k],uid,True) for k in ('workspace','home','temporary')]
            require(preserve or not any(claude_dirs[0].iterdir()),'fresh Claude workspace required')
            for index,a in enumerate(claude_dirs):
                for b in [*roots,*claude_dirs[index+1:]]:
                    require(a!=b and a not in b.parents and b not in a.parents,'isolated Claude path overlap')
        package_files = manager.FILES | role_files | host_files | claude_files
        modules={}
        for folder,names in (('broker',config.BROKER),('isolation',config.ISOLATION),
                             ('codex_bounded',config.MODULES),('codex_service',manager.MODULES_SERVICE),
                             ('broker',getattr(manager,'SERVICE_BROKER',()))):
            for name in names:
                original=src/('' if folder=='broker' else folder)/name
                modules[folder+'/'+name]=original.read_bytes()
        generated={'server','native','manager.py','launcher.py','service.json','profile.json','beta.json'}
        require(set(modules)|generated==manager.FILES,'authoritative inventory changed; review packager')
        if claude_plan:
            for name in manager.CLAUDE_BROKER:
                modules['broker/'+name]=(src/name).read_bytes()
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
            if host_files:
                write(inner/'codex-code-mode-host',Path(plan['code_mode_host']).read_bytes(),gid,True)
                require(pin(inner/'codex-code-mode-host')['sha256']==plan['code_mode_host_sha256'],
                        'copied executable mismatch')
            for name,mode in (('manager.py','manager'),('launcher.py','broker')):write(inner/name,entry(inner,mode),gid,True)
            beta={'schema_version':1,'owner_id':plan['owner_id'],'conversation_id':plan['conversation_id'],
                  'manager_socket':str(endpoint/'control.sock'),'launcher':str(inner/'launcher.py'),
                  'launcher_sha256':pin(inner/'launcher.py')['sha256'],'workspace':str(workspace),
                  'namespace':plan['namespace'],'supervisor_key':plan['supervisor_key']}
            runtime={'format':'orkestr-v2-codex-service-v1','uid':uid,'gid':gid,
                     'owner_id':plan['owner_id'],'conversation_id':plan['conversation_id'],'home':str(home),
                     'bootstrap_file':plan['bootstrap_file'],'ledger_directory':str(ledger),
                     'endpoint_directory':str(endpoint),'port':plan['port'],'trusted_origin':plan['origin']}
            profile={'format':'orkestr-v2-codex-isolated-v2','native':str(inner/'native'),
                     'auth_file':str(auth),'state_root':str(account),'workspace':str(workspace),
                     'egress_socket':str(endpoint/'egress.sock'),'supervisor':str(inner/'isolation/supervisor.py'),
                     'hosts':list(config.HOSTS)}
            if role_paths is not None:
                beta['roles']=selected_roles.emit(inner,role_paths,profile,gid,entry,write,encoded)
            if 'workspace_exec' in plan:
                beta['workspace_exec']=plan['workspace_exec']
            if 'additional_workspace_exec' in plan:
                beta['additional_workspace_exec']=plan['additional_workspace_exec']
            if 'max_active_windows' in plan:
                beta['max_active_windows']=plan['max_active_windows']
            for key in ('window_max_minutes', 'conversation_window_max_minutes', 'conversation_workspaces'):
                if key in plan:
                    beta[key]=plan[key]
            if 'host_full_access' in plan:
                beta['host_full_access']=plan['host_full_access']
            if 'live_map' in plan:
                runtime['live_map']=plan['live_map']
            if 'desktop_broker' in plan:
                runtime['desktop_broker']=plan['desktop_broker']
            if 'timer_config' in plan:
                runtime['timer_config']=plan['timer_config']
            if 'metrics_port' in plan:
                runtime['metrics_port']=plan['metrics_port']
            if 'v1_chat_icons_dir' in plan:
                runtime['v1_chat_icons_dir']=plan['v1_chat_icons_dir']
            if 'whatsapp_chats' in plan:
                runtime['whatsapp_chats']=plan['whatsapp_chats']
            for key in ('claude_quota_projection','codex_quota_projection'):
                if key in plan:
                    runtime[key]=plan[key]
            if claude_plan:
                launcher=inner/'launcher-claude.py'
                write(launcher,entry(inner,'broker-claude'),gid,True)
                private={**{k:claude_plan[k] for k in CLAUDE_PATHS},
                         'host_full_access':{'environment':plan['host_full_access']['environment']}}
                write(inner/'claude-private.json',encoded(private),gid)
                beta['claude']={'launcher':str(launcher),'launcher_sha256':pin(launcher)['sha256'],
                                'workspace':claude_plan['workspace'],'default':claude_plan.get('default',False),
                                'fast':claude_plan.get('fast',False)}
            validate_beta(encoded(beta))
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
                      'files':{name:pin(inner/name)['sha256'] for name in sorted(package_files)},
                      'dependencies':deps,'ui':{name:info['sha256'] for name,info in pair['web']['files'].items()}}
            write(inner/'manifest.json',encoded(manifest),gid);digest=pin(inner/'manifest.json')['sha256']
            manager.Package(inner,digest);final_bindings(inner,inner,gid)
            write(output/'start-service',wrapper(output,Path('/usr/bin/python3').resolve(),digest),gid,True)
            receipt={'format':'orkestr-v2-selected-service-release-v1','source_commit':source,
                     'version':pair['version'],'pair_sha256':plan['pair_sha256'],'native_sha256':plan['native_sha256'],
                     'inner_manifest_sha256':digest,'files':inventory(output),'activated':False,
                     'startup_dependencies':{name:pin(trusted(Path(name).resolve())) for name in ('/bin/sh','/usr/bin/python3')},
                     'credential_contents_read':False,'provider_invoked':False,
                     'preserved_existing_state':preserve,'roles_enabled':role_paths is not None,
                     'workspace_exec_enabled':'workspace_exec' in beta,
                     'host_full_access_enabled':'host_full_access' in beta,
                     'claude_enabled':'claude' in beta,
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
