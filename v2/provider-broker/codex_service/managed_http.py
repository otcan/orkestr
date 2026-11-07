"""Bounded stateless HTTP MCP for the original Root-registered host native.

No bearer, caller PID/role header, stdio forwarder or Root command endpoint.
TCP identity is kernel tuple/inode + original pidfd, not SO_PEERCRED.
"""
import hashlib
import json
import re
import socket
import time
from .contract import canonical,require,unique
from .managed_ingress import MAX_PACKET,packet,source
from .managed_socket_owner import socket_owner
from . import managed_capabilities,managed_context

def tools(ingress,scope):
    result=[];desk=ingress.manager.desk
    operations=[] if desk is None else sorted(k for k,v in desk.operations.items()
        if v['conversation_id']==scope['conversation_id'])
    if operations:
        result.append({'name':'orkestr_desk_login','description':
            'Use an owner-granted scoped login helper. Wait through owner verification. An unknown outcome must not be retried automatically.',
            'inputSchema':{'type':'object','properties':{'operation_id':{'type':'string','enum':operations}},
                'required':['operation_id'],'additionalProperties':False},
            'annotations':{'readOnlyHint':False,'destructiveHint':True,'idempotentHint':False,'openWorldHint':True}})
    result.append({'name':'orkestr_root_request_submit','description':
        'Submit an agent-requested summary to protected owner review. This does not approve the request or transfer business execution to Root.',
        'inputSchema':{'type':'object','properties':{k:{'type':'string','minLength':1,'maxLength':cap}
            for k,cap in (('action',256),('resource',512),('summary',4096))},
            'required':['action','resource','summary'],'additionalProperties':False},
        'annotations':{'readOnlyHint':False,'destructiveHint':True,'idempotentHint':False,'openWorldHint':True}})
    result.append(managed_capabilities.advertisement())
    return result


def discovery(ingress,scope):
    value=managed_capabilities.manifest(scope,tools(ingress,scope))
    value['application_instructions']=managed_context.instructions()
    return value


class Listener:
    def __init__(self,ingress):
        self.ingress=ingress
        self.socket=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
        self.socket.bind(('127.0.0.1',0));self.socket.listen(16);self.socket.setblocking(False)
        self.url='http://127.0.0.1:'+str(self.socket.getsockname()[1])+'/mcp'

    def accept(self):
        connection,_=self.socket.accept()
        connection.setblocking(False)
        return Peer(self.ingress,connection)

    def close(self):self.socket.close()


class Peer:
    def __init__(self,ingress,connection):
        self.ingress,self.connection=ingress,connection
        self.source=self.proof=self.path=self.request=None
        self.deadline=time.monotonic()+35;self.registration_deadline=time.monotonic()+2
        self.buffer=bytearray();self.call=None;self.metadata_done=False

    def authenticate(self):
        try:identity=socket_owner(self.ingress,self.connection)
        except Exception:
            if self.proof is None and time.monotonic()<self.registration_deadline:raise BlockingIOError()
            raise
        if self.proof is not None:
            require(identity==self.proof.identity,'managed_http_actor_changed')
            return  # Rechecks do not consume the per-native request budget.
        self.source,self.proof=source(self.ingress.manager,identity['pid'],identity['uid'])
        record=self.ingress.natives.actor(identity['pid'])
        count=record.get('http_requests',0)+1
        require(count<=managed_capabilities.HTTP_REQUESTS_MAX,'managed_http_request_bound');record['http_requests']=count

    def receive(self):
        self.authenticate()
        part=self.connection.recv(MAX_PACKET+4097-len(self.buffer));require(part,'managed_http_eof')
        self.buffer.extend(part);require(len(self.buffer)<=MAX_PACKET+4096,'managed_http_bound')
        end=self.buffer.find(b'\r\n\r\n')
        if end<0:
            require(len(self.buffer)<=4096,'managed_http_headers_bound');raise BlockingIOError()
        require(end<=4096,'managed_http_headers_bound')
        lines=bytes(self.buffer[:end]).decode('ascii','strict').split('\r\n')
        require(lines[0] in ('POST /mcp HTTP/1.1','GET /mcp HTTP/1.1'),'managed_http_path')
        headers={}
        for line in lines[1:]:
            require(':' in line and not line[:1].isspace(),'managed_http_header')
            name,value=line.split(':',1);name=name.lower();value=value.strip()
            require(re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-z-]+",name) is not None and name not in headers
                    and '\0' not in value and name not in ('transfer-encoding','upgrade'),'managed_http_header')
            headers[name]=value
        if lines[0].startswith('GET '):
            self.send_http(405,b'');self.metadata_done=True;return None
        length=headers.get('content-length','')
        require(re.fullmatch('[0-9]{1,5}',length) is not None and 0<int(length)<=MAX_PACKET,'managed_http_length')
        total=end+4+int(length)
        if len(self.buffer)<total:raise BlockingIOError()
        require(len(self.buffer)==total and headers.get('content-type','').split(';')[0].strip()=='application/json',
                'managed_http_body')
        self.authenticate()  # Full body must retain its original kernel actor.
        value=json.loads(bytes(self.buffer[end+4:]).decode('utf-8','strict'),object_pairs_hook=unique)
        require(type(value) is dict and set(value)<={'jsonrpc','id','method','params'} and value.get('jsonrpc')=='2.0'
                and type(value.get('method')) is str and type(value.get('params',{})) is dict,'managed_mcp_request')
        method=value['method'];params=value.get('params',{});self.call=value.get('id')
        if method=='notifications/initialized':
            require('id' not in value,'managed_mcp_notification');self.send_http(202,b'');self.metadata_done=True;return None
        require(type(self.call) in (str,int) and not isinstance(self.call,bool)
                and len(str(self.call).encode())<=128,'managed_mcp_request_id')
        if method=='initialize':
            version=params.get('protocolVersion')
            require(type(version) is str and re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}',version),'managed_mcp_version')
            self.result({'protocolVersion':version,'capabilities':{'tools':{}},
                'serverInfo':{'name':'orkestr-managed','version':'1'},
                'instructions':canonical(discovery(self.ingress,self.source)).decode()})
            self.metadata_done=True;return None
        if method=='tools/list':
            require(set(params)<={'cursor','_meta'},'managed_mcp_list_fields')
            require(not params.get('cursor'),'managed_mcp_cursor')
            self.result({'tools':tools(self.ingress,self.source)});self.metadata_done=True;return None
        if method=='ping':
            self.result({});self.metadata_done=True;return None
        if method!='tools/call':
            # Capability probes (including newer discovery extensions) must
            # receive the standard unsupported-method response, not a broken
            # transport that could hide the supported tools/list fallback.
            self.send_http(200,canonical({'jsonrpc':'2.0','id':self.call,
                'error':{'code':-32601,'message':'Method not found'}}))
            self.metadata_done=True;return None
        require(method=='tools/call' and set(params)<={'name','arguments','_meta'} and
                {'name','arguments'}<=set(params),'managed_mcp_method')
        name=params['name'];arguments=params['arguments']
        if name==managed_capabilities.NAME:
            require(type(arguments) is dict and not arguments,'managed_capability_arguments')
            value=discovery(self.ingress,self.source)
            self.result({'content':[{'type':'text','text':canonical(value).decode()}],
                         'structuredContent':value,'isError':False})
            self.metadata_done=True;return None
        require(name in ('orkestr_desk_login','orkestr_root_request_submit'),'managed_mcp_tool')
        # The native's RPC correlation, not a model-selected key, is stable
        # across an exact transport retry. Core additionally binds the live run.
        request_key='mcp:'+hashlib.sha256(canonical([self.call,name])).hexdigest()
        operation='desk_login' if name=='orkestr_desk_login' else 'root_request_submit'
        return packet(canonical({'version':1,'request_key':request_key,'operation':operation,'arguments':arguments}))

    def send_http(self,status,body):
        self.authenticate()  # No cached identity across a helper/owner wait.
        names={200:'OK',202:'Accepted',405:'Method Not Allowed'}
        headers=('HTTP/1.1 '+str(status)+' '+names[status]+'\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: '+
            str(len(body))+'\r\nConnection: close\r\n\r\n').encode()
        frame=headers+body;require(len(frame)<=MAX_PACKET,'managed_http_reply_bound')
        require(self.connection.send(frame)==len(frame),'managed_http_reply_unknown')

    def result(self,value):
        self.send_http(200,canonical({'jsonrpc':'2.0','id':self.call,'result':value}))

    def reply(self,value):
        text=canonical({'state':value['state'],'result':value['result']}).decode()
        failed=value['state']!='completed' or (type(value['result']) is dict and value['result'].get('kind')=='desk_helper'
                                              and value['result'].get('state')!='helper_completed')
        self.result({'content':[{'type':'text','text':text}],'isError':failed})

    def close(self):
        self.connection.close()
        if self.proof is not None:self.proof.close()
