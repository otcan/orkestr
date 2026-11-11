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
        'lease_generation','dispatch_fence','expires_at_ms','hard_deadline_ms','evidence','source_message_id','source_event_id'},'managed_capability_fields')
    identifier(value['operation_id']);identifier(value['run_id'])
    identifier(value['source_message_id']);identifier(value['source_event_id'])
    for field in ('binding_generation','lease_generation','dispatch_fence'):generation(value[field])
    require(type(value['expires_at_ms']) is int and 0<value['expires_at_ms']-int(time.time()*1000)<=30000,
            'managed_capability_expired')
    require(type(value['hard_deadline_ms']) is int and value['expires_at_ms']<=value['hard_deadline_ms']
            and value['hard_deadline_ms']-int(time.time()*1000)<=300000,'managed_hard_deadline')
    evidence=value['evidence']
    require(type(evidence) is dict and set(evidence)=={'source','request'},'managed_evidence')
    return value


def normalize_source(value):
    return {**value,'native_session_id':value.get('native_session_id'),'resume_setup_id':value.get('resume_setup_id')}


def result_capability(value):
    require(type(value) is dict and set(value)=={'operation_id','run_id','lease_generation','dispatch_fence',
            'expires_at_ms','result_sha256'},'managed_result_fields')
    identifier(value['operation_id']);identifier(value['run_id'])
    generation(value['lease_generation']);generation(value['dispatch_fence'])
    require(type(value['expires_at_ms']) is int and 0<value['expires_at_ms']-int(time.time()*1000)<=30000
            and type(value['result_sha256']) is str and len(value['result_sha256'])==64
            and all(c in '0123456789abcdef' for c in value['result_sha256']),'managed_result_capability')
    return value


def authorize_result(ingress,cap,request):
    from .managed_runs import key
    cap=result_capability(cap);path=ingress.directory/(cap['operation_id']+'.json');record=metadata(protected(path),32768)
    source=record['source'];previous=record.get('latest_capability',record['capability'])
    require(source['window_id']==request['window_id'] and source['window_generation']==request['generation']
            and source['owner_id']==request['owner_id'] and source['conversation_id']==request['conversation_id'],
            'managed_result_scope')
    require(record['state']=='completed' and not record.get('delivery_cancelled') and record['run_id']==cap['run_id']
            and cap['lease_generation']==previous['lease_generation'] and cap['dispatch_fence']==previous['dispatch_fence']
            and cap['expires_at_ms']==previous['expires_at_ms'],'managed_result_scope')
    require(ingress.runs.contexts.get(key(source),{}).get('run_id')==cap['run_id']
            and ingress.manager._desk_window_active(source['window_id'],source['window_generation']),
            'managed_result_run_closed')
    expected=hashlib.sha256(canonical({'state':record['state'],'result':record['result']})).hexdigest()
    require(expected==cap['result_sha256'],'managed_result_changed')
    fingerprint=hashlib.sha256(canonical(cap)).hexdigest()
    require(record.get('result_authorization') in (None,fingerprint),'managed_result_conflict')
    record['result_authorization']=fingerprint;record['result_expires_at_ms']=cap['expires_at_ms'];atomic(path,record)
    return record


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
    require(source['run_id']==cap['run_id'],'managed_consumed_run_changed')
    pending=ingress.pending(source['window_id'],source['window_generation'])
    require(any(r['request_id']==operation for r in pending),'managed_caller_not_live')
    require(cap['binding_generation']>=source['generation'],'managed_binding_lineage')
    record.update(state='consumed',capability_sha256=fingerprint,run_id=cap['run_id'],capability=cap)
    for peer in ingress.peers:
        if peer.request==operation:peer.deadline=time.monotonic()+max(0,cap['hard_deadline_ms']-int(time.time()*1000))/1000+5
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
                'correlation_sha256':record['payload_sha256'],'expires_at_ms':cap['expires_at_ms'],
                'hard_deadline_ms':cap['hard_deadline_ms']}
            manager.desk.start({'owner_id':source['owner_id'],'conversation_id':source['conversation_id'],
                'window_id':source['window_id'],'generation':source['window_generation'],'capability':desk},manager.launcher)
        atomic(path,record)
        return record
    except BaseException:
        record['state']='unknown';atomic(path,record);raise


def renew(ingress,cap):
    cap=capability(cap);path=ingress.directory/(cap['operation_id']+'.json');record=metadata(protected(path),32768)
    require(record['state'] in ('consumed','completed') and record['request']['operation']=='desk_login','managed_renewal_not_active')
    previous=record.get('latest_capability',record['capability'])
    fixed=set(cap)-{'lease_generation','expires_at_ms'}
    require(all(cap[field]==previous[field] for field in fixed) and cap['lease_generation']==previous['lease_generation']+1
            and cap['expires_at_ms']>previous['expires_at_ms'],'managed_renewal_scope')
    if record['state']=='completed':return record  # A terminal receipt is not a renewed effect.
    source=record['source'];manager=ingress.manager
    require(manager._desk_window_active(source['window_id'],source['window_generation'])
            and any(peer.request==record['request_id'] and not peer.proof.exited() for peer in ingress.peers),
            'managed_renewal_caller_gone')
    record['latest_capability']=cap;atomic(path,record)
    try:
        manager.desk.renew(record['request_id'],cap['lease_generation'],cap['expires_at_ms'],cap['hard_deadline_ms'])
    except BaseException:
        record['state']='unknown';atomic(path,record);manager.desk.cancel(record['request_id']);raise
    return record


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
    # Only a claim that can still change state can be a consumed desk login.
    for path,record in ingress.journal.unsettled_records():
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
    if operation in ('managed_worker_bind','managed_worker_reply'):
        from .managed_worker_reply import bind,reply
        record=bind(ingress,request) if operation=='managed_worker_bind' else reply(ingress,request)
        return {'ok':True,'receipt':manager.ledger.status(request['conversation_id']),
                operation:{'operation_id':record['request_id'],'run_id':record['run_id'],'authorized':True}}
    if operation=='managed_result':
        record=authorize_result(ingress,request['result'],request)
        return {'ok':True,'receipt':manager.ledger.status(request['conversation_id']),
                'managed_result':{'operation_id':record['request_id'],'run_id':record['run_id'],'authorized':True}}
    if operation in ('managed_run_open','managed_run_close'):
        if operation=='managed_run_open':run=ingress.runs.open(request)
        else:
            run=request['run_id'];ingress.runs.close(window_id,generation,run)
        return {'ok':True,'receipt':manager.ledger.status(request['conversation_id']),'managed_run':{'run_id':run}}
    if operation=='managed_pending':
        return {'ok':True,'receipt':manager.ledger.status(request['conversation_id']),
                'managed_pending':ingress.pending(window_id,generation)}
    if operation in ('managed_consume','managed_renew'):
        cap=request['capability'];scope=cap['evidence']['source']
        require(scope['window_id']==window_id and scope['window_generation']==generation and
                scope['owner_id']==request['owner_id'] and scope['conversation_id']==request['conversation_id'],
                'managed_control_scope')
        record=consume(ingress,cap) if operation=='managed_consume' else renew(ingress,cap)
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
