"""Fixed authority-peer operations over an already Root-observed caller.

Never callable on the provider socket. Root does not read Core here: the exact
owned authority server supplies a consumed Core grant through control.sock.
"""
import hashlib
import stat
import time
from codex_bounded.trust import metadata,protected
from .contract import canonical,generation,identifier,require
from .launch import atomic


def capability(value):
    require(type(value) is dict and set(value)=={'operation_id','run_id','binding_generation',
        'lease_generation','dispatch_fence','expires_at_ms','evidence','source_message_id','source_event_id'},'managed_capability_fields')
    identifier(value['operation_id']);identifier(value['run_id'])
    identifier(value['source_message_id']);identifier(value['source_event_id'])
    for field in ('binding_generation','lease_generation','dispatch_fence'):generation(value[field])
    require(type(value['expires_at_ms']) is int and 0<value['expires_at_ms']-int(time.time()*1000)<=30000,
            'managed_capability_expired')
    evidence=value['evidence']
    require(type(evidence) is dict and set(evidence)=={'source','request'},'managed_evidence')
    return value


def normalize_source(value):
    return {**value,'native_session_id':value.get('native_session_id'),'resume_setup_id':value.get('resume_setup_id')}


def consume(ingress,cap):
    cap=capability(cap);operation=cap['operation_id'];path=ingress.directory/(operation+'.json')
    require(path.exists(),'managed_unknown_request');record=metadata(protected(path),32768)
    require(normalize_source(record['source'])==cap['evidence']['source'] and record['request']==cap['evidence']['request'],
            'managed_evidence_changed')
    fingerprint=hashlib.sha256(canonical(cap)).hexdigest()
    if record['state']!='pending':
        require(record.get('capability_sha256')==fingerprint,'managed_consumption_conflict')
        return record  # Lost delivery cannot authorize another effect.
    source=record['source'];manager=ingress.manager
    pending=ingress.pending(source['window_id'],source['window_generation'])
    require(any(r['request_id']==operation for r in pending),'managed_caller_not_live')
    require(cap['binding_generation']>=source['generation'],'managed_binding_lineage')
    record.update(state='consumed',capability_sha256=fingerprint,run_id=cap['run_id'],capability=cap)
    atomic(path,record)  # Persist before queue publication/helper launch.
    try:
        request=record['request']
        if request['operation']=='root_request_submit':
            publish(ingress,record)
            record.update(state='completed',result={'kind':'protected_root_intake','request_id':operation,
                'owner_approval':False,'owner_delivery':'unconfirmed'})
        elif request['operation']=='desk_login':
            require(manager.desk is not None,'managed_desk_unconfigured')
            desk={'operation_id':operation,'resource_id':request['arguments']['operation_id'],'run_id':cap['run_id'],
                'session_id':source['session_id'],'binding_generation':cap['binding_generation'],
                'setup_generation':source['generation'],'lease_generation':cap['lease_generation'],
                'dispatch_fence':cap['dispatch_fence'],'incarnation':source['incarnation'],
                'correlation_sha256':record['payload_sha256'],'expires_at_ms':cap['expires_at_ms']}
            manager.desk.start({'owner_id':source['owner_id'],'conversation_id':source['conversation_id'],
                'window_id':source['window_id'],'generation':source['window_generation'],'capability':desk},manager.launcher)
        atomic(path,record)
        return record
    except BaseException:
        record['state']='unknown';atomic(path,record);raise


def publish(ingress,record):
    """Protected intake only; no owner decision, watcher delivery or business work.

    A watcher adapter may consume this Root-only directory after qualification.
    Existing shared-group/writable inboxes are deliberately not used.
    """
    directory=ingress.manager.package.ledger_directory/'root-request-submissions'
    directory.mkdir(mode=0o700,exist_ok=True);protected(directory,True)
    require(stat.S_IMODE(directory.stat().st_mode)==0o700,'managed_intake_custody')
    source=record['source'];arguments=record['request']['arguments']
    payload={'format':'orkestr-managed-root-request-v1','kind':'request','request_id':record['request_id'],
        'owner_id':source['owner_id'],
        'source_conversation_id':source['conversation_id'],'source_session_id':source['session_id'],
        'source_provider':source['provider'],'source_setup_generation':source['generation'],
        'source_resume_setup_id':source.get('resume_setup_id'),'run_id':record['run_id'],
        'action':arguments['action'],'resource':arguments['resource'],'agent_requested_summary':arguments['summary'],
        'owner_instruction_reference':None,'owner_approved':False,
        'core_input_reference':{'message_id':record['capability']['source_message_id'],
                                'event_id':record['capability']['source_event_id']},
        'core_capability_sha256':record['capability_sha256'],'state':'pending_owner_review'}
    path=directory/(record['request_id']+'.json')
    require(not path.exists(),'managed_intake_already_exists')
    atomic(path,payload)


def tick(ingress):
    desk=ingress.manager.desk
    if desk is None:return
    for path in ingress.directory.glob('*.json'):
        record=metadata(path,32768)
        if record['state']!='consumed' or record['request']['operation']!='desk_login':continue
        receipt_path=desk.directory/(record['request_id']+'.json')
        receipt=desk.receipt(receipt_path)
        if receipt['state'] in ('helper_completed','failed','cancelled','unknown'):
            record['state']='unknown' if receipt['state']=='unknown' or not receipt['cleanup'] else 'completed'
            record['result']={'kind':'desk_helper','state':receipt['state'],'cleanup':receipt['cleanup'],
                              'website_login':'unconfirmed'}
            atomic(path,record)


def receipt(record):
    source=record['source']
    return {'operation_id':record['request_id'],'run_id':record.get('run_id'),
        'window_id':source['window_id'],'generation':source['window_generation'],
        'state':record['state'],'result':record.get('result')}


def dispatch(manager,request,window):
    ingress=manager.managed
    require(ingress is not None,'managed_unconfigured')
    operation=request['operation'];window_id=request['window_id'];generation=request['generation']
    if operation=='managed_pending':
        return {'ok':True,'receipt':manager.ledger.status(request['conversation_id']),
                'managed_pending':ingress.pending(window_id,generation)}
    if operation=='managed_consume':
        cap=request['capability'];scope=cap['evidence']['source']
        require(scope['window_id']==window_id and scope['window_generation']==generation and
                scope['owner_id']==request['owner_id'] and scope['conversation_id']==request['conversation_id'],
                'managed_control_scope')
        record=consume(ingress,cap)
    else:
        path=ingress.directory/(identifier(request['operation_id'])+'.json');record=metadata(protected(path),32768)
        source=record['source']
        require(source['window_id']==window_id and source['window_generation']==generation and
                source['conversation_id']==request['conversation_id'],'managed_control_scope')
        if operation=='managed_cancel' and record['state'] not in ('completed','unknown','cancelled'):
            if record['request']['operation']=='desk_login' and record['state']=='consumed':
                manager.desk.cancel(record['request_id'])
            else:record['state']='cancelled';atomic(path,record)
    return {'ok':True,'receipt':manager.ledger.status(request['conversation_id']),'managed_operation':receipt(record)}
