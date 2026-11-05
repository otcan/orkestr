"""Read-only live Root tree/pipe observations; no original CLI registration."""
import os
from pathlib import Path
import stat
from codex_bounded.trust import digest,exists,metadata,process,protected,system_dependency,Refused as CustodyRefused
from .contract import require,Refused
from .ownership import Adopted,Process

CLAIM_FIELDS=('request_id','server','manager_pid','proxy_pid','proxy_start','broker_pid',
              'broker_start','role','mode','window_id','generation','setup','native_io')


def claim_identity(value):return {key:value[key] for key in CLAIM_FIELDS}


def matches(claim,core):
    setup=claim.get('setup',{})
    return (type(setup) is dict and claim.get('role')==('fast' if core['provider']=='codex' else 'claude')
        and setup.get('role')=='fast'
        and all(setup.get(left)==core[right] for left,right in (
            ('owner_id','owner_id'),('conversation_id','conversation_id'),('session_id','session_id'),
            ('provider','provider'),('incarnation','incarnation_id')))
        and claim.get('window_id')==core['window_id'] and claim.get('generation')==core['window_generation']
        and type(setup.get('generation')) is int and 0<setup['generation']<=core['binding_generation']
        and setup.get('native_session_id',core['native_session_id'])==core['native_session_id'])


def executable(identity,expected):
    expected=protected(expected)
    actual=Path('/proc',str(identity['pid']),'exe').stat();pinned=expected.stat()
    require((actual.st_dev,actual.st_ino)==(pinned.st_dev,pinned.st_ino),'fast_process_executable')
    return {'device':actual.st_dev,'inode':actual.st_ino,'sha256':digest(expected)}


def actor(pid,start,uid,expected,nnp=False):
    identity=process(pid)
    require(identity and identity['start']==start and identity['uid']==uid,'fast_process_identity')
    proof=Process(identity)
    try:
        exe=executable(identity,expected)
        if nnp:
            require(any(line.startswith('NoNewPrivs:') and line.split()[1]=='1'
                for line in Path('/proc',str(pid),'status').read_text().splitlines()),'fast_process_nnp')
        require(not proof.exited() and exists(identity),'fast_process_changed')
        return {**identity,'executable':exe}
    finally:proof.close()


def pipes(pid,expected):
    require(type(expected) is dict and set(expected)=={'input','output'},'fast_root_io_fields')
    result={}
    for fd,name in ((0,'input'),(1,'output')):
        info=Path('/proc',str(pid),'fd',str(fd)).stat()
        require(stat.S_ISFIFO(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600
            and (info.st_dev,info.st_ino)==(expected[name]['device'],expected[name]['inode']),
            'fast_root_io_identity')
        result[name]={'device':info.st_dev,'inode':info.st_ino,'creator_uid':info.st_uid,'mode':0o600}
    require(result['input']['inode']!=result['output']['inode'],'fast_root_io_alias')
    return result


def descendants(parent,uid):
    pending=[parent];seen={};result=[]
    while pending:
        current=pending.pop();key=(current['pid'],current['start'])
        require(len(seen)<128,'fast_tree_bound')
        if key in seen:continue
        require(exists(current),'fast_tree_changed');seen[key]=current
        for pid in Adopted.children(current):
            child=process(pid)
            if child and child['ppid']==current['pid']:
                require(child['uid']==uid,'fast_tree_uid')
                pending.append(child);result.append(child)
    require(all(exists(value) for value in seen.values()),'fast_tree_changed')
    return result


def listener(server,port):
    require(type(port) is int and 1024<=port<=65535,'fast_service_port')
    owned=set();base=Path('/proc',str(server['pid']))
    for fd in (base/'fd').iterdir():
        try:target=os.readlink(fd)
        except FileNotFoundError:continue
        if target.startswith('socket:['):owned.add(target[8:-1])
    expected='0100007F:'+format(port,'04X')
    found=[]
    for line in (base/'net/tcp').read_text().splitlines()[1:]:
        fields=line.split()
        if len(fields)>=10 and fields[1]==expected and fields[3]=='0A' and fields[9] in owned:
            require(fields[7]==str(server['uid']),'fast_listener_uid');found.append(fields[9])
    require(len(found)==1 and exists(server),'fast_original_listener')
    return {'port':port,'socket_inode':found[0]}


def current(package,snapshot):
    server=snapshot['server'];manager=snapshot['manager']
    live_server=actor(server['pid'],server['start'],package.authority_uid,package.root/'server')
    live_manager=actor(manager['pid'],manager['start'],0,Path('/usr/bin/python3').resolve(strict=True))
    require(live_server['ppid']==live_manager['pid'],'fast_original_manager')
    return listener(live_server,package.runtime['port'])


def observe(package,path,claim):
    require(claim['state']=='spawned','fast_launch_not_live')
    python=system_dependency(Path('/usr/bin/python3').resolve(strict=True))
    server=actor(claim['server']['pid'],claim['server']['start'],package.authority_uid,package.root/'server')
    manager_identity=process(claim['manager_pid']);require(manager_identity,'fast_manager_missing')
    manager=actor(manager_identity['pid'],manager_identity['start'],0,python)
    proxy=actor(claim['proxy_pid'],claim['proxy_start'],package.authority_uid,python,True)
    broker=actor(claim['broker_pid'],claim['broker_start'],package.executor_uid,python,True)
    require(server['ppid']==manager['pid'] and proxy['ppid']==server['pid'] and broker['ppid']==manager['pid']
            and manager['start']<=min(server['start'],broker['start']) and server['start']<=proxy['start'],
            'fast_original_tree')
    native=package.root/'native' if claim['setup']['provider']=='codex' else Path(
        metadata(protected(package.root/'claude-private.json'))['executable'])
    observed=[]
    for child in descendants(broker,package.executor_uid):
        try:
            candidate=actor(child['pid'],child['start'],package.executor_uid,native,True)
            candidate['root_io']=pipes(child['pid'],claim['native_io']);observed.append(candidate)
        except (OSError,ValueError,Refused,CustodyRefused):
            # Non-native wrappers are metadata only, never the pinned actor.
            continue
    require(len(observed)==1,'fast_root_io_holder_not_observed')
    require(all(exists(value) for value in (server,manager,proxy,broker,*observed)),'fast_sample_changed')
    require(claim_identity(metadata(protected(path),32768))==claim_identity(claim),'fast_launch_changed')
    return {'server':server,'manager':manager,'proxy':proxy,'broker':broker,
            'observed_native_process':{**observed[0],'metadata_only':True},'native_pid_claim':None,
            'original_native_pid_registered':False}
