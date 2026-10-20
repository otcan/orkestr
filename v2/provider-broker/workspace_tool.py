"""Closed workspace command wire validators, not tool admission or execution authority.

Unregistered: trusted profile selection and Runtime's sealed tool-result fence
must be reviewed before Channel may call these helpers.
"""
import unicodedata
from protocol import exact, identifier, require

NAME='orkestr_workspace_exec'


TRUSTED_DESCRIPTION=('Run a shell command in the approved project workspace under the operator\'s '
    'trusted profile (host toolchains; network and credentials only as configured). Pass {command} '
    'for a short command; its output returns directly. For long builds or tests pass '
    '{command, background:true}; the result names a job. Then pass {job, action:"wait"} (waits '
    'briefly), {job, action:"status"} or {job, action:"cancel"}. Redirect large output to a '
    'workspace file and read it with later commands.')
JOB_PREFIX='#!orkestr-job '
ACTIONS=('status','wait','cancel')


def advertisement(trusted=False):
    require(type(trusted) is bool)
    if trusted:
        return {'type':'function','name':NAME,'description':TRUSTED_DESCRIPTION,
            'inputSchema':{'type':'object','properties':{
                'command':{'type':'string','maxLength':32768},'background':{'type':'boolean'},
                'job':{'type':'string','maxLength':64},
                'action':{'type':'string','enum':list(ACTIONS)}},
                'additionalProperties':False}}
    return {'type':'function','name':NAME,
        'description':'Run a bounded shell command in the approved project workspace, without network or account access.',
        'inputSchema':{'type':'object','properties':{'command':{'type':'string',
            'maxLength':32768}},'required':['command'],'additionalProperties':False}}


def request_id(value):
    # Codex numbers server requests from 0 in each app-server process.
    return (type(value) is int and 0<=value<2**53) or (
        isinstance(value,str) and 0<len(value.encode())<=128
        and not any(unicodedata.category(char)=='Cc' for char in value))


def command(value):
    return (isinstance(value,str) and 0<len(value.encode())<=32768 and '\0' not in value
            and not value.startswith(JOB_PREFIX))


def job_id(value):
    return (isinstance(value,str) and len(value)==36 and all(
        (char=='-') if index in (8,13,18,23) else char in '0123456789abcdef'
        for index,char in enumerate(value)))


def trusted_arguments(arguments):
    """Shape only; Runtime derives the canonical audited operation text."""
    require(isinstance(arguments,dict) and set(arguments)<={'command','background','job','action'})
    if 'command' in arguments:
        require('job' not in arguments and 'action' not in arguments and command(arguments['command']))
        require(type(arguments.get('background',False)) is bool)
    else:
        require('job' in arguments and 'background' not in arguments and job_id(arguments['job']))
        require(arguments.get('action','status') in ACTIONS)
    return dict(arguments)


def validate_call(frame, native, turn, trusted=False):
    exact(frame,('id','method','params'))
    require(request_id(frame['id']) and frame['method']=='item/tool/call')
    params=frame['params']
    require(isinstance(params,dict))
    fields=('arguments','callId','threadId','turnId','tool')
    exact(params,fields+(('namespace',) if 'namespace' in params else ()))
    require(params.get('namespace') is None and params['tool']==NAME)
    require(identifier(native) and identifier(turn))
    require(params['threadId']==native and params['turnId']==turn)
    require(identifier(params['callId']) and len(params['callId'].encode())<=128)
    if trusted:
        arguments=trusted_arguments(params['arguments'])
    else:
        exact(params['arguments'],('command',))
        require(command(params['arguments']['command']))
        arguments={'command':params['arguments']['command']}
    # Return no fabricated grant and no mutable alias into the provider input.
    return {'id':frame['id'],'method':'item/tool/call','params':{
        'arguments':arguments,'callId':params['callId'],
        'threadId':native,'turnId':turn,'tool':NAME}}


def validate_result(frame, pending_id):
    exact(frame,('id','result'))
    require(request_id(pending_id) and type(frame['id']) is type(pending_id)
            and frame['id']==pending_id)
    result=frame['result'];exact(result,('contentItems','success'))
    require(type(result['success']) is bool)
    items=result['contentItems']
    require(isinstance(items,list) and len(items)==1)
    exact(items[0],('type','text'))
    text=items[0]['text']
    require(items[0]['type']=='inputText' and isinstance(text,str) and len(text.encode())<=8192)
    return {'id':pending_id,'result':{'contentItems':[{'type':'inputText','text':text}],
                                    'success':result['success']}}


def validate_submission(envelope, owned_handle, pending_id):
    """Validate the agreed outer wire only; preparation creates no authority."""
    exact(envelope,('id','method','params'))
    require(request_id(envelope['id']) and envelope['method']=='ToolResult')
    params=envelope['params'];exact(params,('owned_handle','frame'))
    require(identifier(owned_handle) and params['owned_handle']==owned_handle)
    frame=validate_result(params['frame'],pending_id)
    return {'id':envelope['id'],'method':'ToolResult',
            'params':{'owned_handle':owned_handle,'frame':frame}}
