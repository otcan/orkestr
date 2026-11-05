"""Metadata-only original native registration from the original immutable broker.

No Core/business authority is issued here. Later HTTP requests must be owned by
this exact pinned PID/start, not another descendant with a similar executable.
"""
from pathlib import Path
import stat
import time
import uuid
from codex_bounded.trust import exists,metadata,process,protected
from .contract import require
from .launch import atomic
from .ownership import Process


def pipe_pair(pid,expected):
    for fd,name in ((0,'input'),(1,'output')):
        info=Path('/proc',str(pid),'fd',str(fd)).stat()
        require(stat.S_ISFIFO(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600
                and (info.st_dev,info.st_ino)==(expected[name]['device'],expected[name]['inode']),
                'managed_native_pipe_identity')


class NativeRegistry:
    def __init__(self,ingress):
        self.ingress=ingress;self.records={}
        self.directory=ingress.manager.package.ledger_directory/'native-registrations'
        self.directory.mkdir(mode=0o700,exist_ok=True);protected(self.directory,True)
        require(self.directory.stat().st_mode&0o777==0o700,'managed_native_journal_custody')

    def register(self,peer,value):
        source=peer.source;arguments=value['arguments'];manager=self.ingress.manager
        require(source['caller_pid']==source['broker_pid'] and source['caller_start']==source['broker_start'],
                'managed_native_original_broker')
        # This mode deliberately refuses bwrap intermediaries. A managed host
        # exec/env/prlimit chain preserves the original Popen PID throughout.
        require(type(manager.package.beta.get('managed_host')) is dict,'managed_native_host_required')
        handle=next((h for h in manager.launcher.children.values() if h.broker['pid']==source['broker_pid']
                     and h.broker['start']==source['broker_start']),None)
        require(handle and getattr(handle,'native_io',None),'managed_native_original_handle')
        key=(source['broker_pid'],source['broker_start']);identity=process(arguments['pid'])
        require(identity and identity['ppid']==source['broker_pid'] and identity['start']==arguments['start']
                and identity['uid']==manager.package.executor_uid,'managed_native_original_child')
        require(any(line.startswith('NoNewPrivs:') and line.split()[1]=='1'
                    for line in Path('/proc',str(identity['pid']),'status').read_text().splitlines()),'managed_native_nnp')
        pipe_pair(identity['pid'],handle.native_io)
        if key in self.records:
            original=self.records[key]
            require(original['proof'].identity==identity and not original['proof'].exited(),'managed_native_registration_conflict')
            return original['id']
        proof=Process(identity)
        try:
            path=self.directory/(str(source['broker_pid'])+'-'+str(source['broker_start'])+'.json')
            require(not path.exists(),'managed_native_registration_already_claimed')
            identifier=str(uuid.uuid4())
            record={'registration_id':identifier,'source':source,'native':identity,
                    'native_io':handle.native_io,'state':'bound','created_at_ms':time.time_ns()//1000000}
            atomic(path,record)
            self.records[key]={'id':identifier,'proof':proof,'handle':handle,'source':source,'path':path}
            return identifier
        except BaseException:proof.close();raise

    def actor(self,pid):
        matches=[record for record in self.records.values() if record['proof'].identity['pid']==pid]
        require(len(matches)==1,'managed_native_not_registered');record=matches[0]
        proof=record['proof'];handle=record['handle'];manager=self.ingress.manager
        require(not proof.exited() and exists(proof.identity) and handle.child.poll() is None
                and exists(handle.broker) and manager._desk_window_active(handle.window,handle.generation),
                'managed_native_no_longer_live')
        pipe_pair(pid,handle.native_io)
        source=record['source']
        if source['provider']=='codex':executable=protected(manager.package.root/'native')
        elif source['provider']=='claude':executable=protected(metadata(manager.package.root/'claude-private.json')['executable'])
        else:require(False,'managed_native_provider')
        actual=Path('/proc',str(pid),'exe').stat();expected=executable.stat()
        require((actual.st_dev,actual.st_ino)==(expected.st_dev,expected.st_ino),'managed_native_executable')
        # Same-UID memory/FD injection must not be enabled on a qualified host.
        require(int(Path('/proc/sys/kernel/yama/ptrace_scope').read_text())>=1,'managed_native_ptrace_boundary')
        return record

    def prune(self):
        for key,record in list(self.records.items()):
            if record['proof'].exited() or record['handle'].child.poll() is not None:
                value=metadata(record['path'],32768);value['state']='native_exited';atomic(record['path'],value)
                record['proof'].close();del self.records[key]

    def close(self):
        for record in self.records.values():record['proof'].close()
        self.records={}
