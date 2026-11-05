"""Deep-only fixed operation correlation. This module grants no Root authority."""
from protocol import exact,identifier,require
from workspace_tool import request_id,validate_submission

NAME='orkestr_desk_login'
DESCRIPTION='Request one operator-approved desk login by operation ID. No command, credential, path, conversation or environment is accepted.'


def advertisement():
    return {'type':'function','name':NAME,'description':DESCRIPTION,'inputSchema':{
        'type':'object','properties':{'operation_id':{'type':'string','maxLength':128}},
        'required':['operation_id'],'additionalProperties':False}}


def validate_call(frame,native,turn):
    exact(frame,('id','method','params'));require(request_id(frame['id']) and frame['method']=='item/tool/call')
    params=frame['params'];require(type(params) is dict)
    fields=('arguments','callId','threadId','turnId','tool')
    exact(params,fields+(('namespace',) if 'namespace' in params else ()))
    require(params.get('namespace') is None and params['tool']==NAME)
    require(identifier(native) and identifier(turn) and params['threadId']==native and params['turnId']==turn)
    require(identifier(params['callId']) and len(params['callId'])<=128)
    exact(params['arguments'],('operation_id',));operation=params['arguments']['operation_id']
    require(type(operation) is str and 0<len(operation)<=128 and
            all(c.isascii() and (c.isalnum() or c in '._:-') for c in operation))
    return {'id':frame['id'],'method':'item/tool/call','params':{'tool':NAME,'callId':params['callId'],
        'threadId':native,'turnId':turn,'arguments':{'operation_id':operation}}}


class DeskRoute:
    def __init__(self):
        self.pending=None;self.ids=set();self.calls=set()

    def receive(self,frame,native,turn):
        require(self.pending is None and len(self.calls)<8)
        clean=validate_call(frame,native,turn);key=(type(clean['id']),clean['id']);call=clean['params']['callId']
        require(key not in self.ids and call not in self.calls)
        self.ids.add(key);self.calls.add(call);self.pending=clean['id'];return clean

    def submit(self,envelope,handle):
        require(self.pending is not None)
        clean=validate_submission(envelope,handle,self.pending);self.pending=None;return clean['params']['frame']

    def cancel(self):
        pending=self.pending is not None;self.pending=None;return pending
