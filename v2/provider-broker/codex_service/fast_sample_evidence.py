"""Root-private diagnostic witnesses, never inference or Root authority."""
import hashlib
import os
from pathlib import Path
import secrets
import stat
from codex_bounded.trust import metadata,protected
from .contract import canonical,identifier,require

FORMAT='orkestr-fast-native-observation-v1'
MUTABLE={'state','dispatch_state','acceptance_event_id'}
FIELDS={'schema_version','owner_id','conversation_id','input_message_id','input_event_id',
        'run_id','session_id','native_session_id','provider','binding_generation','context_id',
        'incarnation_id','window_id','window_generation'}|MUTABLE


def scope(value):
    require(type(value) is dict and set(value)==FIELDS,'fast_core_fields')
    require(type(value['schema_version']) is int and value['schema_version']==1,'fast_core_schema')
    for key in ('owner_id','conversation_id','input_message_id','input_event_id','run_id','session_id','window_id'):
        identifier(value[key])
    for key in ('native_session_id','context_id','incarnation_id','state','dispatch_state'):
        item=value[key]
        require(type(item) is str and 0<len(item.encode())<=256 and not any(c in item for c in '\0\r\n'),
                'fast_core_identity')
    require(value['provider'] in ('codex','claude'),'fast_core_provider')
    for key in ('binding_generation','window_generation'):
        require(type(value[key]) is int and 0<value[key]<2**53,'fast_core_generation')
    if value['acceptance_event_id'] is not None:identifier(value['acceptance_event_id'])
    return {key:value[key] for key in sorted(FIELDS-MUTABLE)}


def read(path):
    path=protected(path)
    require(stat.S_IMODE(path.stat().st_mode)==0o600,'fast_snapshot_private')
    value=metadata(path,65536)
    require(value.get('format')==FORMAT and value.get('live_observed') is True
            and value.get('original_native_pid_registered') is False and value.get('native_pid_claim') is None,
            'fast_snapshot_format')
    return value


def publish(directory,value):
    directory=protected(Path(directory),True)
    require(stat.S_IMODE(directory.stat().st_mode)==0o700,'fast_snapshot_directory')
    name=identifier(value['core_scope']['run_id'])+'.json';path=directory/name
    frame=canonical(value);require(len(frame)<=65536,'fast_snapshot_bound')
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    temporary='.fast-'+secrets.token_hex(16)
    try:
        output=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
        with os.fdopen(output,'wb') as stream:
            stream.write(frame);stream.flush();os.fsync(stream.fileno())
        try:os.link(temporary,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
        except FileExistsError:
            existing=read(path)
            require(existing['core_scope']==value['core_scope'],'fast_snapshot_scope_conflict')
            # Retain the first actual observation, not a replacement actor.
            require(existing['launch']['identity']==value['launch']['identity'],'fast_snapshot_actor_conflict')
        os.fsync(fd)
    finally:
        try:os.unlink(temporary,dir_fd=fd)
        except FileNotFoundError:pass
        try:os.fsync(fd)
        finally:os.close(fd)
    return path


def summary(path):
    return {'status':'observed','receipt_path':str(path),
            'receipt_sha256':hashlib.sha256(protected(path).read_bytes()).hexdigest()}
