"""Current Core writer binds/results to its original Native caller; no new effect."""
import hashlib
import time
from codex_bounded.trust import metadata,protected
from .contract import canonical,identifier,require
from .launch import atomic
from .managed_control import normalize_source
from .managed_runs import key


def authorized(ingress,request,field):
    value=request['result']
    require(type(value) is dict and set(value)=={'operation_id','run_id','source','request_sha256',
            'expires_at_ms',field},'managed_worker_reply_fields')
    identifier(value['operation_id']);identifier(value['run_id'])
    require(type(value['expires_at_ms']) is int and 0<value['expires_at_ms']-int(time.time()*1000)<=30000,
            'managed_worker_reply_expired')
    path=ingress.directory/(value['operation_id']+'.json');record=metadata(protected(path),32768)
    source=record['source']
    require(record['request']['operation'] in ('worker_capability','worker_submit','worker_status','worker_wait')
            and normalize_source(source)==value['source'] and source['run_id']==value['run_id']
            and record['payload_sha256']==value['request_sha256'],'managed_worker_original_request')
    require(source['window_id']==request['window_id'] and source['window_generation']==request['generation']
            and source['owner_id']==request['owner_id'] and source['conversation_id']==request['conversation_id'],
            'managed_worker_reply_scope')
    require(ingress.runs.contexts.get(key(source),{}).get('run_id')==value['run_id']
            and ingress.manager._desk_window_active(source['window_id'],source['window_generation']),
            'managed_worker_run_closed')
    return value,path,record


def bind(ingress,request):
    value,path,record=authorized(ingress,request,'task_id');identifier(value['task_id'])
    require(record['request']['operation'] in ('worker_submit','worker_wait'),'managed_worker_wait_operation')
    if record['state']=='worker_waiting':
        require(record.get('native_task_id')==value['task_id'],'managed_worker_binding_conflict')
        return record
    source=record['source']
    require(record['state']=='pending' and any(r['request_id']==record['request_id']
            for r in ingress.pending(source['window_id'],source['window_generation'])),
            'managed_worker_caller_not_live')
    # Four observers correspond to the existing four bounded scheduler slots.
    # A run's claims all belong to the run's (this claim's) window.
    active=sum(1 for p in ingress.journal.window_paths(source['window_id']) if (lambda r:r['state']=='worker_waiting'
        and r['source']['run_id']==value['run_id'])(metadata(protected(p),32768)))
    require(active<4,'managed_worker_waiter_bound')
    record.update(state='worker_waiting',run_id=value['run_id'],native_task_id=value['task_id'])
    atomic(path,record)  # Unblock another pending submission before any child wait.
    return record


def reply(ingress,request):
    value,path,record=authorized(ingress,request,'result')
    require(type(value['result']) is dict and len(canonical(value['result']))<=4096
            and value['result'].get('kind') in ('native_worker_task','native_worker_capability'),
            'managed_worker_result_bound')
    source=record['source'];result_hash=hashlib.sha256(canonical(value['result'])).hexdigest()
    if record['state']=='completed':
        require(record.get('native_result_sha256')==result_hash and not record.get('delivery_cancelled'),
                'managed_worker_reply_conflict')
        return record
    if record['state']=='worker_waiting':
        require(value['result'].get('task_id')==record.get('native_task_id')
                and value['result'].get('parent_run_id')==value['run_id'],'managed_worker_bound_task_changed')
    else:
        require(record['state']=='pending' and any(r['request_id']==record['request_id']
                for r in ingress.pending(source['window_id'],source['window_generation'])),
                'managed_worker_caller_not_live')
    # Root still requires original pidfd/HTTP custody on delivery. A restart
    # marks pending/waiting unknown and cannot reconstruct that authority.
    record.update(state='completed',run_id=value['run_id'],result=value['result'],
        native_result_sha256=result_hash,result_authorization=hashlib.sha256(canonical(value)).hexdigest(),
        result_expires_at_ms=value['expires_at_ms'])
    atomic(path,record)
    return record
