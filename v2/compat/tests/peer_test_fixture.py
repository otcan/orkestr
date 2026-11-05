"""Actual dropped-UID HTTP child plus a Root-published original actor descriptor.

Only disposable synthetic HTTP data; no installed release, provider or account.
"""
import importlib.util
import inspect
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import types
import uuid
import threading
import queue

ROOT=Path(__file__).resolve().parents[2]


def publisher_module():
    path=ROOT/'provider-broker';sys.path.insert(0,str(path))
    try:
        from codex_service import manager_service_peer
        return manager_service_peer
    finally:sys.path.remove(str(path))


class CorePeer:
    def __init__(self,root,handler,*,uid=62121,port=0):
        self._root=Path(root);self._root.chmod(0o755)
        self._reports=self._root/('reports-'+str(uid));self._reports.mkdir(mode=0o700);os.chown(self._reports,uid,uid)
        self._report=self._reports/'calls.json'
        binary=self._root/('server-'+str(uid));shutil.copyfile(Path('/proc/self/exe').resolve(),binary);binary.chmod(0o555)
        self._package_root=self._root/('package-'+str(uid));self._package_root.mkdir(mode=0o755)
        shutil.copyfile(binary,self._package_root/'server');(self._package_root/'server').chmod(0o555)
        source=inspect.getsource(handler)
        script='''import hashlib,json,os,socket,sys,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
TOKEN='d'*64
KEY='00000000-0000-4000-8000-000000000002'
SOURCE='a'*40
SECRET='c'*64
OWNER='00000000-0000-4000-8000-000000000001'
CONVERSATION='00000000-0000-4000-8000-000000000002'
PREFIX='/api/v2/conversations/'+CONVERSATION
'''+source+'''
class Calls(list):
 def append(self,value):
  super().append(value)
  p=sys.argv[1]+'.pending'
  with open(p,'w') as out:json.dump(self,out)
  os.replace(p,sys.argv[1])
server=ThreadingHTTPServer(('127.0.0.1',int(sys.argv[2])),Peer)
server.calls=Calls();server.requests=server.calls;server.source='a'*40;server.owner=OWNER;server.conversation=CONVERSATION
server.post_status=201;server.unknown_post=False;server.revoked=False;server.reject_service=False;server.reject_cookie=False;server.unknown_create=False
exchange_event=threading.Event();server.on_exchange=None
def exchange():
 exchange_event.clear();print(json.dumps({'event':'exchange'}),flush=True);exchange_event.wait(3)
print(json.dumps({'port':server.server_port}),flush=True)
def control():
 for raw in sys.stdin:
  command=json.loads(raw)
  if 'set' in command:
   for key,value in command['set'].items():setattr(server,key,exchange if key=='on_exchange' and value else value)
   print(json.dumps({'ack':command['id']}),flush=True)
  elif command.get('operation')=='close_listener':
   server.shutdown();server.server_close();print(json.dumps({'ack':command['id']}),flush=True)
  elif command.get('operation')=='exchange_ack':exchange_event.set()
threading.Thread(target=control,daemon=True).start()
server.serve_forever(poll_interval=.01)
# Preserve the original actor after a deliberate listener close.
threading.Event().wait()
'''
        self._process=subprocess.Popen([str(self._package_root/'server'),'-I','-S','-B','-c',script,str(self._report),str(port)],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,
            user=uid,group=uid,extra_groups=[],env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        if not select.select([self._process.stdout],[],[],5)[0]:
            self._process.terminate();self._process.wait(timeout=3);raise RuntimeError('synthetic_core_start_timeout')
        self.server_port=json.loads(self._process.stdout.readline())['port'];self._publisher=None
        self._command_lock=threading.Lock();self._replies=queue.Queue();self._on_exchange=None
        self._monitor=threading.Thread(target=self.monitor,daemon=True);self._monitor.start()
        self._settings={'source':'a'*40,'owner':'00000000-0000-4000-8000-000000000001',
                        'conversation':'00000000-0000-4000-8000-000000000002','post_status':201,'unknown_post':False,'revoked':False,'reject_service':False,'reject_cookie':False,'unknown_create':False,'on_exchange':None}
        self._ready=True

    def publish(self):
        module=publisher_module();control=self._root/'endpoints';control.mkdir(mode=0o700,exist_ok=True)
        package=types.SimpleNamespace(control=control/'manager.sock',root=self._package_root,
            authority_uid=self._process.pid and int(Path('/proc',str(self._process.pid),'status').read_text().split('Uid:')[1].split()[1]),
            owner=self._settings['owner'],runtime={'port':self.server_port},manifest={'source_commit':self._settings['source']})
        self._publisher=module.Publisher(package,self._process,module.actor(self._process.pid))
        return self._publisher.path

    def __getattr__(self,key):
        if key in ('calls','requests'):
            try:return [tuple(row) for row in json.loads(self._report.read_text())]
            except FileNotFoundError:return []
        if key in self._settings:return self._settings[key]
        raise AttributeError(key)

    def __setattr__(self,key,value):
        if self.__dict__.get('_ready') and key in self._settings:
            if key=='on_exchange':self._on_exchange=value;wire=bool(value)
            else:wire=value
            self.command({'set':{key:wire}});self._settings[key]=value
        else:object.__setattr__(self,key,value)

    def monitor(self):
        for raw in self._process.stdout:
            value=json.loads(raw)
            if value.get('event')=='exchange':
                try:
                    if self._on_exchange:self._on_exchange()
                finally:
                    self._process.stdin.write(json.dumps({'operation':'exchange_ack'})+'\n');self._process.stdin.flush()
            else:self._replies.put(value)

    def command(self,value):
        with self._command_lock:
            value={**value,'id':str(uuid.uuid4())}
            self._process.stdin.write(json.dumps(value)+'\n');self._process.stdin.flush()
            result=self._replies.get(timeout=3)
            if result.get('ack')!=value['id']:raise RuntimeError('synthetic_core_command_mismatch')

    def close_listener(self):self.command({'operation':'close_listener'})

    def close(self):
        try:
            if self._publisher is not None:self._publisher.close();self._publisher=None
        finally:
            if self._process.poll() is None:self._process.terminate()
            self._process.wait(timeout=3);self._monitor.join(timeout=3);self._process.stdin.close();self._process.stdout.close()
