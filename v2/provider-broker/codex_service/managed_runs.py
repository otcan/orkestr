"""Authority-only consumed-run observation; never a business operation grant."""
from codex_bounded.trust import exists,metadata,protected
from .contract import identifier,require
from .launch import atomic


def key(source):
    return (source['window_id'],source['window_generation'],source['broker_pid'],source['broker_start'])


def setup(value):
    return {**value,'native_session_id':value.get('native_session_id'),'resume_setup_id':value.get('resume_setup_id')}


class Runs:
    def __init__(self,ingress):
        self.ingress=ingress;self.contexts={}
        self.directory=ingress.manager.package.ledger_directory/'managed-runs'
        self.directory.mkdir(mode=0o700,exist_ok=True);protected(self.directory,True)
        require(self.directory.stat().st_mode&0o777==0o700,'managed_run_journal_custody')

    def open(self,request):
        value=request['run'];require(type(value) is dict and set(value)=={'run_id','source_message_id','source_event_id','setup'},
                                     'managed_run_fields')
        for field in ('run_id','source_message_id','source_event_id'):identifier(value[field])
        manager=self.ingress.manager;source=value['setup'];matches=[]
        require(type(source) is dict and set(source)=={'owner_id','conversation_id','session_id','generation',
                'role','provider','incarnation','native_session_id','resume_setup_id'},'managed_run_setup_fields')
        require(manager._desk_window_active(request['window_id'],request['generation']),'managed_run_window')
        require(source['owner_id']==request['owner_id'] and source['conversation_id']==request['conversation_id'],
                'managed_run_scope')
        for handle in manager.launcher.children.values() if manager.launcher else []:
            if handle.window!=request['window_id'] or handle.generation!=request['generation'] or handle.child.poll() is not None:continue
            record=metadata(handle.path,16384)
            if (exists(handle.broker) and record['state']=='spawned' and record['role'] in ('deep','claude')
                    and record['setup']['role']=='deep' and setup(record['setup'])==source):matches.append(handle)
        require(len(matches)==1,'managed_run_original_setup')
        handle=matches[0];scope={'window_id':handle.window,'window_generation':handle.generation,
            'broker_pid':handle.broker['pid'],'broker_start':handle.broker['start']}
        selected=key(scope);path=self.directory/(value['run_id']+'.json')
        if selected in self.contexts:
            require(self.contexts[selected]==value,'managed_run_not_closed');return value['run_id']
        require(not path.exists(),'managed_run_already_claimed')
        atomic(path,{'run':value,'scope':scope,'state':'open'})
        self.contexts[selected]=value;return value['run_id']

    def attach(self,peer):
        value=self.contexts.get(key(peer.source));require(value,'managed_no_consumed_run')
        peer.source={**peer.source,'run_id':value['run_id']}

    def close(self,window,generation,run):
        identifier(run);path=self.directory/(run+'.json');value=metadata(protected(path),32768)
        scope=value['scope'];require(scope['window_id']==window and scope['window_generation']==generation,'managed_run_scope')
        if value['state']=='open':
            value['state']='closed';atomic(path,value);self.contexts.pop(key(scope),None)
        for pending in self.ingress.directory.glob('*.json'):
            record=metadata(pending,32768)
            if record['source'].get('run_id')==run and record['state']=='pending':
                record['state']='cancelled';atomic(pending,record)
