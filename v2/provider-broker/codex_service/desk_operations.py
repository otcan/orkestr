"""Core-issued fixed desk operations. Root owns mapping, claim and cleanup.

No native-visible bearer, arbitrary command/path/environment or direct Vault
access. Unknown Root delivery remains consumed and prevents window retirement.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import time
from codex_bounded.trust import digest,exists,metadata,process,protected
from .contract import require,identifier,generation,key,canonical
from .launch import atomic


def mapping(value):
    require(type(value) is dict and set(value)=={'helper','sha256','conversation_id','desk','site','duration_ms'},'desk_mapping_fields')
    identifier(value['conversation_id']);key(value['desk'])
    require(type(value['helper']) is str and value['helper'].startswith('/') and
            type(value['sha256']) is str and re.fullmatch('[0-9a-f]{64}',value['sha256']) and
            type(value['site']) is str and re.fullmatch('[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]',value['site']) and
            type(value['duration_ms']) is int and 1<=value['duration_ms']<=300000,'desk_mapping')
    return value


def capability(value):
    require(type(value) is dict and set(value)-{'hard_deadline_ms'}=={'operation_id','resource_id','run_id','session_id',
        'binding_generation','setup_generation','lease_generation','dispatch_fence','incarnation','correlation_sha256','expires_at_ms'},'desk_capability_fields')
    for field in ('operation_id','run_id','session_id'):identifier(value[field])
    key(value['resource_id']);key(value['incarnation'])
    for field in ('binding_generation','setup_generation','lease_generation','dispatch_fence'):generation(value[field])
    require(value['binding_generation']>=value['setup_generation'],'desk_binding_lineage')
    require(type(value['correlation_sha256']) is str and re.fullmatch('[0-9a-f]{64}',value['correlation_sha256']) and
            type(value['expires_at_ms']) is int and 0<value['expires_at_ms']<2**53,'desk_capability')
    if 'hard_deadline_ms' in value:
        require(type(value['hard_deadline_ms']) is int and value['expires_at_ms']<=value['hard_deadline_ms']
                and value['hard_deadline_ms']-int(time.time()*1000)<=300000,'desk_hard_deadline')
    return value


class Operations:
    def __init__(self,package):
        require(os.geteuid()==0 and package.identity_split,'desk_root_split')
        self.package=package;self.active={};self.faulted=False
        definition=package.runtime.get('desk_login')
        require(type(definition) is dict and set(definition)=={'path','sha256'},'desk_operator_configuration')
        path=protected(definition['path']);require(digest(path)==definition['sha256'],'desk_configuration_pin')
        value=metadata(path,32768)
        require(set(value)=={'format','operations'} and value['format']=='orkestr-desk-operations-v1' and
                type(value['operations']) is dict and 0<len(value['operations'])<=32,'desk_configuration')
        self.operations=value['operations']
        for resource,entry in self.operations.items():key(resource);mapping(entry)
        self.directory=package.ledger_directory/'desk-operations'
        self.directory.mkdir(mode=0o700,exist_ok=True);protected(self.directory,True)
        require(self.directory.stat().st_mode&0o777==0o700,'desk_journal_custody')
        self.parent=process(os.getpid())

    def receipt(self,path):
        record=metadata(path,16384)
        return {k:record[k] for k in ('operation_id','run_id','window_id','generation','state','cleanup')}

    def start(self,request,launcher):
        require(not self.faulted,'desk_custody_fault')
        cap=capability(request['capability']);identifier(request['owner_id']);identifier(request['conversation_id'])
        require(request['owner_id']==self.package.owner,'desk_owner_scope')
        operation=self.operations.get(cap['resource_id'])
        require(operation and operation['conversation_id']==request['conversation_id'],'desk_resource_scope')
        remaining=cap['expires_at_ms']-int(time.time()*1000)
        require(0<remaining<=30000,'desk_deadline')
        matches=[]
        for handle in launcher.children.values():
            record=metadata(handle.path,16384);setup=record['setup']
            if (handle.window==request['window_id'] and handle.generation==request['generation'] and
                record.get('state')=='spawned' and handle.child.poll() is None and exists(handle.broker) and
                setup['owner_id']==request['owner_id'] and setup['conversation_id']==request['conversation_id'] and
                setup['role']=='deep' and setup['session_id']==cap['session_id'] and
                setup['generation']==cap['setup_generation'] and setup['incarnation']==cap['incarnation']):matches.append(handle)
        require(len(matches)==1,'desk_managed_deep_lineage')
        helper=protected(operation['helper']);require(digest(helper)==operation['sha256'],'desk_helper_pin')
        frozen={k:request[k] for k in ('owner_id','conversation_id','window_id','generation','capability')}
        fingerprint=hashlib.sha256(canonical(frozen)).hexdigest()
        path=self.directory/(cap['operation_id']+'.json')
        if path.exists():
            require(metadata(path)['sha256']==fingerprint,'desk_replay_conflict')
            return self.receipt(path)
        records=[metadata(p,16384) for p in self.directory.glob('*.json')]
        require(not any(r['run_id']==cap['run_id'] and r['correlation_sha256']==cap['correlation_sha256'] for r in records),'desk_call_already_consumed')
        require(sum(r['window_id']==request['window_id'] for r in records)<8,'desk_window_bound')
        hard=min(cap.get('hard_deadline_ms',cap['expires_at_ms']),int(time.time()*1000)+operation['duration_ms'])
        now_ns=time.monotonic_ns();wall_ms=int(time.time()*1000)
        hard_ns=now_ns+max(0,hard-wall_ms)*1000000
        lease_ns=min(hard_ns,now_ns+max(0,cap['expires_at_ms']-wall_ms)*1000000)
        record={**frozen,**{k:cap[k] for k in ('operation_id','run_id','correlation_sha256')},'sha256':fingerprint,
                'state':'claimed','cleanup':False,'hard_deadline_ms':hard,'lease_generation':cap['lease_generation']}
        atomic(path,record)  # Persist before Popen. Unknown outcome is consumed.
        parent,child=socket.socketpair();process_handle=None
        try:
            interpreter=str(Path('/usr/bin/python3').resolve())
            process_handle=subprocess.Popen([interpreter,'-I','-S','-B',str(self.package.root/'codex_service/entry.py'),
                'desk-anchor',str(child.fileno()),str(self.parent['pid']),str(self.parent['start'])],
                pass_fds=(child.fileno(),),cwd='/',env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'},
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            child.close()
            payload={**operation,'hard_deadline_ns':hard_ns,'lease_deadline_ns':lease_ns}
            payload=canonical(payload);parent.sendall(struct.pack('!I',len(payload))+payload);parent.setblocking(False)
            identity=process(process_handle.pid);require(identity and identity['ppid']==os.getpid() and identity['uid']==0,'desk_anchor_identity')
            self.active[cap['operation_id']]={'child':process_handle,'identity':identity,'socket':parent,'path':path,'proof':None,
                'broker':dict(matches[0].broker),'window':request['window_id'],'generation':request['generation'],
                'deadline':lease_ns/1000000000,'deadline_ns':lease_ns,'hard_deadline_ns':hard_ns,
                'cancelled':False,'uncertain':False,'buffer':b''}
            record.update(state='running',anchor=identity);atomic(path,record)
            return self.receipt(path)
        except BaseException:
            record['state']='unknown';atomic(path,record)
            # Keep original ownership after a post-Popen local failure. Manager
            # cannot call this completed or retry its durable claimed operation.
            if process_handle is not None and cap['operation_id'] not in self.active:
                self.active[cap['operation_id']]={'child':process_handle,'identity':process(process_handle.pid),'socket':parent,'path':path,
                    'proof':None,'broker':dict(matches[0].broker),'window':request['window_id'],'generation':request['generation'],
                    'deadline':0,'cancelled':False,'uncertain':True,'buffer':b''}
            if process_handle is None:parent.close()
            elif cap['operation_id'] in self.active:self.active[cap['operation_id']]['uncertain']=True
            child.close();raise

    def cancel(self,operation):
        handle=self.active.get(operation)
        if handle and not handle['cancelled']:
            handle['cancelled']=True
            try:handle['socket'].send(b'C')
            except OSError:pass

    def renew(self,operation,lease,expires,hard_deadline):
        handle=self.active.get(operation);path=self.directory/(operation+'.json');record=metadata(path,16384)
        if handle is None:
            require(record['state'] in ('helper_completed','failed','cancelled') and record['cleanup'],'desk_renewal_unknown')
            return
        require(not handle['cancelled'] and not handle['uncertain'] and lease==record['lease_generation']+1
                and int(time.time()*1000)<expires<=hard_deadline and hard_deadline==record['capability'].get('hard_deadline_ms')
                and 0<expires-int(time.time()*1000)<=30000,'desk_renewal_scope')
        deadline=min(handle['hard_deadline_ns'],time.monotonic_ns()+max(0,expires-int(time.time()*1000))*1000000)
        require(time.monotonic_ns()<handle['deadline_ns'] and deadline>=handle['deadline_ns'],'desk_renewal_expired')
        record['lease_generation']=lease;record['renewed_expires_at_ms']=expires;atomic(path,record)
        if deadline==handle['deadline_ns']:return  # Sealed shorter mapping already caps this helper.
        command=b'R'+struct.pack('!Q',deadline)
        try:
            require(handle['socket'].send(command)==len(command),'desk_renewal_delivery_unknown')
            handle['deadline_ns']=deadline;handle['deadline']=deadline/1000000000
        except BaseException:
            handle['uncertain']=True;record['state']='unknown';atomic(path,record);self.cancel(operation);raise

    def fault(self):
        self.faulted=True
        for operation,handle in self.active.items():
            handle['uncertain']=True;self.cancel(operation)
            record=metadata(handle['path'],16384);record['state']='unknown';atomic(handle['path'],record)

    def tick(self,window_active):
        for operation,handle in list(self.active.items()):
            if (time.monotonic()>=handle['deadline'] or not exists(handle['broker']) or
                not window_active(handle['window'],handle['generation'])):self.cancel(operation)
            try:raw=handle['socket'].recv(1025)
            except BlockingIOError:raw=None
            except OSError:raw=b''
            if raw:
                handle['buffer']+=raw
                try:
                    require(len(handle['buffer'])<=1024,'desk_anchor_proof_bound')
                    if len(handle['buffer'])<4:continue
                    length=struct.unpack('!I',handle['buffer'][:4])[0]
                    require(0<length<=1020,'desk_anchor_proof_bound')
                    if len(handle['buffer'])<length+4:continue
                    require(len(handle['buffer'])==length+4,'desk_anchor_proof_trailing')
                    proof=json.loads(handle['buffer'][4:])
                    require(type(proof) is dict and set(proof)=={'cleanup','cancelled','helper_exit'} and
                            proof['cleanup'] is True and type(proof['cancelled']) is bool and type(proof['helper_exit']) is int,
                            'desk_anchor_proof')
                    handle['proof']=proof
                except Exception:handle['proof']=False
            if handle['child'].poll() is None:continue
            record=metadata(handle['path'],16384);proof=handle['proof']
            if proof and handle['child'].returncode==0:
                record.update(cleanup=True,state='unknown' if handle['uncertain'] else 'cancelled' if proof['cancelled'] or handle['cancelled'] else
                              ('helper_completed' if proof['helper_exit']==0 else 'failed'))
            else:record['state']='unknown'
            atomic(handle['path'],record);handle['socket'].close();del self.active[operation]

    def window_clean(self,window):
        return all(r.get('cleanup') is True and r.get('state')!='unknown' for p in self.directory.glob('*.json')
                   if (r:=metadata(p,16384)).get('window_id')==window)

    def close(self):
        for operation in self.active:self.cancel(operation)
        until=time.monotonic()+4
        while self.active and time.monotonic()<until:self.tick(lambda *_:False);time.sleep(.01)
        return not self.active and all((r:=metadata(p,16384)).get('cleanup') is True and r.get('state')!='unknown'
                                       for p in self.directory.glob('*.json'))


def dispatch(manager,request,window):
    """Only Manager's exact kernel-authenticated authority peer reaches here."""
    require(manager.package.identity_split and manager.launcher is not None and window is not None,'desk_runtime')
    manager._package_preflight()
    if manager.desk is None:manager.desk=Operations(manager.package)
    operation=request['operation']
    if operation=='desk_login':
        require(manager._desk_window_active(window.window,window.generation),'desk_window')
        receipt=manager.desk.start(request,manager.launcher)
    else:
        path=manager.desk.directory/(request['operation_id']+'.json');stored=metadata(path,16384)
        require(stored['owner_id']==request['owner_id'] and stored['conversation_id']==request['conversation_id'] and
                stored['window_id']==window.window and stored['generation']==window.generation,'desk_receipt_scope')
        if operation=='desk_login_cancel':manager.desk.cancel(request['operation_id'])
        manager.desk.tick(manager._desk_window_active);receipt=manager.desk.receipt(path)
    return {'ok':True,'receipt':manager.ledger.status(request['conversation_id']),'desk_operation':receipt}
