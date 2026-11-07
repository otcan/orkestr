"""Root-observed managed callers. No ambient bearer or caller-owned role proof.

Each seqpacket has fresh kernel credentials, not merely socket-creation peer
credentials. Only actual original descendants of a live Deep broker can enter
the Core queue. This module does not itself grant or execute an operation.
"""
import hashlib
import array
import json
import os
from pathlib import Path
import socket
import stat
import struct
import time
import uuid
from codex_bounded.trust import belongs,exists,metadata,process,protected
from .contract import canonical,key,require,unique
from .custody import OwnedSocket
from .launch import atomic
from .ownership import Process

MAX_PACKET=16384
MAX_CONNECTIONS=32
MAX_WINDOW_REQUESTS=32


def packet(raw):
    require(type(raw) is bytes and 0<len(raw)<=MAX_PACKET,'managed_packet_bound')
    value=json.loads(raw.decode('utf-8','strict'),object_pairs_hook=unique)
    require(type(value) is dict and set(value)=={'version','request_key','operation','arguments'} and
            type(value['version']) is int and value['version']==1,'managed_packet')
    key(value['request_key']);arguments=value['arguments']
    require(type(arguments) is dict,'managed_arguments')
    if value['operation']=='desk_login':
        require(set(arguments)=={'operation_id'},'managed_desk_fields');key(arguments['operation_id'])
    elif value['operation']=='native_register':
        require(set(arguments)=={'pid','start'} and type(arguments['pid']) is int and 1<arguments['pid']<2**31
                and type(arguments['start']) is int and 0<arguments['start']<2**53,'managed_native_fields')
    elif value['operation']=='root_request_submit':
        require(set(arguments)=={'action','resource','summary'},'managed_submit_fields')
        for field,cap in (('action',256),('resource',512),('summary',4096)):
            text=arguments[field]
            require(type(text) is str and 0<len(text.encode())<=cap and '\0' not in text,'managed_submit_text')
    else:require(False,'managed_operation')
    return value


def source(manager,pid,uid):
    identity=process(pid)
    require(identity and uid==manager.package.executor_uid and identity['uid']==uid,'managed_caller_uid')
    status=Path('/proc',str(pid),'status').read_text().splitlines()
    require(any(line.startswith('NoNewPrivs:') and line.split()[1]=='1' for line in status),'managed_caller_nnp')
    proof=Process(identity)
    try:
        matches=[]
        for handle in manager.launcher.children.values() if manager.launcher else []:
            if handle.child.poll() is not None or not exists(handle.broker) or not belongs(pid,handle.broker):continue
            window=manager.windows.get(handle.window)
            require(window and manager._desk_window_active(handle.window,handle.generation),'managed_caller_window')
            window.children.observe()
            caller=(pid,identity['start']);broker=(handle.broker['pid'],handle.broker['start'])
            require(caller in window.children.records and broker in window.children.families.get(caller,set()),'managed_caller_family')
            record=metadata(handle.path,16384);setup=record['setup']
            require(record.get('state')=='spawned' and record['role'] in ('deep','claude') and setup['role']=='deep',
                    'managed_caller_role')
            locator={k:setup[k] for k in ('owner_id','conversation_id','session_id','generation','incarnation','provider')}
            for field in ('native_session_id','resume_setup_id'):
                if field in setup:locator[field]=setup[field]
            locator.update(window_id=handle.window,window_generation=handle.generation,broker_pid=broker[0],broker_start=broker[1],
                           caller_pid=pid,caller_start=identity['start'],caller_uid=uid)
            matches.append(locator)
        require(len(matches)==1 and exists(identity) and not proof.exited(),'managed_caller_lineage')
        return matches[0],proof
    except BaseException:proof.close();raise


class Peer:
    def __init__(self,manager,connection):
        self.connection=connection;self.path=None;self.request=None
        pid,uid,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        self.source,self.proof=source(manager,pid,uid)
        connection.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1);connection.setblocking(False)
        # The operation itself is capped at 30s; retain enough time for the
        # Root anchor's bounded cancellation/reap receipt, never extra work.
        self.deadline=time.monotonic()+35

    def receive(self):
        raw,ancillary,flags,_=self.connection.recvmsg(MAX_PACKET+1,socket.CMSG_SPACE(12),socket.MSG_CMSG_CLOEXEC)
        # Refusing a malicious ancillary message must not leak installed FDs.
        for level,kind,data in ancillary:
            if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:
                fds=array.array('i');fds.frombytes(data[:len(data)//fds.itemsize*fds.itemsize])
                for fd in fds:os.close(fd)
        require(not flags & (socket.MSG_TRUNC|socket.MSG_CTRUNC) and raw,'managed_packet_truncated')
        credentials=[]
        for level,kind,data in ancillary:
            require(level==socket.SOL_SOCKET and kind==socket.SCM_CREDENTIALS and len(data)==12,'managed_packet_credentials')
            credentials.append(struct.unpack('3i',data))
        require(len(credentials)==1 and credentials[0][0]==self.source['caller_pid'] and credentials[0][1]==self.source['caller_uid']
                and exists(self.proof.identity) and not self.proof.exited(),'managed_sender_changed')
        return packet(raw)

    def close(self):
        self.connection.close();self.proof.close()

    def reply(self,value):
        raw=canonical(value);require(self.connection.send(raw)==len(raw),'managed_reply_unknown')


class Ingress:
    def __init__(self,manager):
        require(os.geteuid()==0 and manager.package.identity_split,'managed_root_split')
        self.manager=manager;self.peers=[]
        self.directory=manager.package.ledger_directory/'managed-requests';self.directory.mkdir(mode=0o700,exist_ok=True)
        protected(self.directory,True)
        require(stat.S_IMODE(self.directory.stat().st_mode)==0o700,'managed_journal_custody')
        # A restarted manager cannot reconstruct original caller pidfd proof
        # from disk. Preserve all claims, but never redispatch an old request.
        for path in self.directory.glob('*.json'):
            record=metadata(protected(path),32768)
            if record['state'] not in ('completed','unknown','cancelled'):
                record['state']='unknown';atomic(path,record)
        self.socket=OwnedSocket(manager.package.control.parent/'managed.sock',manager.package.gid,manager.ledger,'managed',0)
        self.socket.socket.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
        self.socket.socket.setblocking(False)
        from .managed_native import NativeRegistry
        self.natives=NativeRegistry(self)
        from .managed_runs import Runs
        self.runs=Runs(self)
        self.http=None
        if (getattr(manager.package,'runtime',{}).get('managed_operations') and
                type(getattr(manager.package,'beta',{}).get('managed_host')) is dict):
            from .managed_http import Listener
            self.http=Listener(self);manager.package.managed_mcp_url=self.http.url

    def _record(self,peer,value):
        self.runs.attach(peer)
        # The logical source, not caller-provided conversation/PID/role, scopes
        # idempotence. A retry cannot create another Root/Core operation.
        stable={k:v for k,v in peer.source.items() if not k.startswith('caller_')}
        digest=hashlib.sha256(canonical({'source':stable,'key':value['request_key']})).digest()
        request=str(uuid.UUID(bytes=digest[:16],version=4));path=self.directory/(request+'.json')
        payload=hashlib.sha256(canonical(value)).hexdigest()
        if path.exists():
            record=metadata(path,32768);require(record['payload_sha256']==payload,'managed_replay_conflict')
            require(record['state']!='pending' or record['source']==peer.source,'managed_original_caller_required')
        else:
            count=sum(1 for p in self.directory.glob('*.json')
                      if metadata(p,32768)['source']['window_id']==peer.source['window_id'])
            require(count<MAX_WINDOW_REQUESTS,'managed_window_bound')
            record={'request_id':request,'source':peer.source,'request':value,'payload_sha256':payload,
                    'created_at_ms':time.time_ns()//1000000,'state':'pending'}
            atomic(path,record)
        peer.path=path;peer.request=request

    def tick(self):
        self.natives.prune()
        while len(self.peers)<MAX_CONNECTIONS:
            try:connection,_=self.socket.socket.accept()
            except BlockingIOError:break
            try:self.peers.append(Peer(self.manager,connection))
            except Exception:connection.close()
        for peer in list(self.peers):
            try:
                require(time.monotonic()<peer.deadline,'managed_caller_gone')
                if peer.proof is not None:
                    require(exists(peer.proof.identity) and not peer.proof.exited(),'managed_caller_gone')
                    require(self.manager._desk_window_active(peer.source['window_id'],peer.source['window_generation']),
                            'managed_window_closed')
                    if hasattr(peer,'authenticate'):peer.authenticate()
                if peer.path is None:
                    try:value=peer.receive()
                    except BlockingIOError:continue
                    if getattr(peer,'metadata_done',False):
                        peer.close();self.peers.remove(peer);continue
                    if value['operation']=='native_register':
                        identifier=self.natives.register(peer,value)
                        peer.connection.send(canonical({'version':1,'request_key':value['request_key'],'request_id':identifier,
                            'state':'completed','result':{'kind':'native_registration'}}))
                        peer.close();self.peers.remove(peer);continue
                    self._record(peer,value)
                record=metadata(peer.path,32768)
                if record['state'] in ('completed','unknown','cancelled'):
                    if record['state']=='completed' and not record.get('delivery_cancelled'):
                        if not record.get('result_authorization'):continue
                        require(record['result_expires_at_ms']>int(time.time()*1000),'managed_result_expired')
                    reply={'version':1,'request_key':record['request']['request_key'],'request_id':record['request_id'],
                           'state':record['state'],'result':record.get('result')}
                    if record.get('delivery_cancelled'):
                        reply.update(state='cancelled',result={'kind':'source_run_closed'})
                    peer.reply(reply)
                    record['result_sent']=True;atomic(peer.path,record)
                    peer.close();self.peers.remove(peer)
            except BlockingIOError:continue
            except Exception:
                if peer.path and peer.path.exists():
                    record=metadata(peer.path,32768)
                    if record['state'] not in ('completed','unknown','cancelled'):
                        record['state']='unknown';atomic(peer.path,record)
                        if record['request']['operation']=='desk_login' and self.manager.desk:
                            self.manager.desk.cancel(record['request_id'])
                peer.close();self.peers.remove(peer)
        # Process metadata-only original-broker registrations before accepting
        # native HTTP connections created during that same startup interval.
        if self.http is not None:
            while len(self.peers)<MAX_CONNECTIONS:
                try:peer=self.http.accept()
                except BlockingIOError:break
                self.peers.append(peer)

    def pending(self,window,generation):
        if not self.manager._desk_window_active(window,generation):return []
        # Disk contains durable claims, never reconstructed caller authority.
        live={}
        for p in self.peers:
            scope=getattr(p,'source',None)
            if not (type(scope) is dict and scope.get('window_id')==window
                    and scope.get('window_generation')==generation):continue
            if not (p.request and p.proof is not None and time.monotonic()<p.deadline
                    and exists(p.proof.identity) and not p.proof.exited()):continue
            try:
                if hasattr(p,'authenticate'):p.authenticate()
            except Exception:continue
            live[p.request]=p.source
        result=[]
        for path in self.directory.glob('*.json'):
            record=metadata(path,32768);scope=record['source']
            if (live.get(record['request_id'])==scope and scope['window_id']==window and scope['window_generation']==generation
                    and record['state']=='pending'):result.append(record)
        return sorted(result,key=lambda r:(r['created_at_ms'],r['request_id']))[:1]

    def close(self):
        for peer in self.peers:
            if peer.path:
                record=metadata(peer.path,32768)
                if record['state'] not in ('completed','unknown','cancelled'):
                    record['state']='unknown';atomic(peer.path,record)
            peer.close()
        self.peers=[];self.socket.close();self.natives.close()
        if self.http is not None:self.http.close()
