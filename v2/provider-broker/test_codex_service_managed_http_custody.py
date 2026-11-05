"""Actual native custody changes cannot borrow a cached HTTP identity."""
import json
import os
import select
import time
from types import SimpleNamespace
import unittest
from codex_bounded.trust import process
from codex_service.contract import Refused
from codex_service.managed_ingress import Ingress,source
import test_codex_service_managed_native as native_tests


@unittest.skipUnless(os.geteuid()==0,'actual separate-UID native kernel proof')
class ContinuedCustodyTests(native_tests.ManagedNativeTests):
    test_only_original_broker_can_register_its_original_child_and_actor_is_pinned=None
    test_a_different_root_pipe_pair_or_bounded_profile_cannot_register=None

    def line(self):
        fd=self.native_descriptors[2];raw=bytearray();until=time.monotonic()+4
        while b'\n' not in raw:
            self.assertLess(time.monotonic(),until)
            if select.select([fd],[],[],.01)[0]:raw.extend(os.read(fd,16384))
        return json.loads(raw.split(b'\n')[0])

    def prepare(self,partial):
        self.manager.package.runtime={'managed_operations':True}
        ingress=Ingress(self.manager);self.addCleanup(ingress.close)
        body=json.dumps({'jsonrpc':'2.0','id':7,'method':'tools/call','params':{
            'name':'orkestr_root_request_submit','arguments':{'action':'read','resource':'example.invalid','summary':'Synthetic'}}}).encode()
        code='''import json,os,socket,sys,time
assert sys.stdin.buffer.read(1)==b'!'
connection=socket.create_connection(('127.0.0.1',%r));connection.settimeout(3)
body=%r
headers=b'POST /mcp HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Type: application/json\\r\\nContent-Length: '+str(len(body)).encode()+b'\\r\\n\\r\\n'
connection.sendall(headers+(b'' if %r else body));print(json.dumps({'ready':True}),flush=True)
command=sys.stdin.buffer.read(1);child=None
if command==b'p':
 reader,writer=os.pipe();os.dup2(reader,0);os.close(reader);os.close(writer)
elif command==b'f':
 child=os.fork()
 if child==0:
  os.close(0);os.close(1);time.sleep(3);os._exit(0)
else:raise AssertionError('fixed test control')
print(json.dumps({'changed':True,'child':child}),flush=True)
try:
 if %r:connection.sendall(body)
 reply=connection.recv(16384);print(json.dumps({'reply':reply.decode()}),flush=True)
except Exception as error:print(json.dumps({'error':type(error).__name__}),flush=True)
finally:
 connection.close()
 if child:
  try:os.kill(child,9)
  except ProcessLookupError:pass
  os.waitpid(child,0)
time.sleep(1)
'''%(ingress.http.socket.getsockname()[1],body,partial,partial)
        broker,native=self.start_native(code)
        scope,proof=source(self.manager,broker.pid,65534);proof.close()
        ingress.natives.register(SimpleNamespace(source=scope),{'arguments':{'pid':native,'start':process(native)['start']}})
        scope,proof=source(self.manager,native,65534);proof.close();self.open_run(ingress,scope)
        os.write(self.native_descriptors[1],b'!');self.assertTrue(self.line()['ready'])
        until=time.monotonic()+3
        while not ingress.peers or ingress.peers[0].proof is None:
            self.assertLess(time.monotonic(),until);ingress.tick();time.sleep(.005)
        return ingress,native

    def test_partial_body_cannot_use_identity_after_original_root_pipe_changes(self):
        ingress,native=self.prepare(True)
        self.assertFalse(list(ingress.directory.glob('*.json')))
        self.assertEqual(ingress.natives.actor(native)['http_requests'],1)
        os.write(self.native_descriptors[1],b'p');self.assertTrue(self.line()['changed'])
        ingress.tick();self.assertFalse(ingress.peers)
        self.assertFalse(list(ingress.directory.glob('*.json')))
        self.assertEqual(self.line().get('reply',''),'')

    def test_pending_dispatch_and_result_recheck_actual_socket_shared_with_child(self):
        ingress,native=self.prepare(False);peer=ingress.peers[0]
        self.assertEqual(len(ingress.pending('synthetic-window',1)),1)
        original=ingress.natives.actor(native)['http_requests'];peer.authenticate();peer.authenticate()
        self.assertEqual(ingress.natives.actor(native)['http_requests'],original)
        os.write(self.native_descriptors[1],b'f');child=self.line()['child'];identity=process(child)
        self.assertIsNotNone(identity)
        self.manager.windows['synthetic-window'].children.records[(child,identity['start'])]=True
        self.assertFalse(ingress.pending('synthetic-window',1))
        with self.assertRaisesRegex(Refused,'managed_http_shared_socket'):
            peer.reply({'state':'completed','result':{'kind':'synthetic-success'}})
        ingress.tick();self.assertFalse(ingress.peers)
        self.assertEqual(self.line().get('reply',''),'')
        records=[json.loads(p.read_text()) for p in ingress.directory.glob('*.json')]
        self.assertEqual([r['state'] for r in records],['unknown'])
        self.assertFalse(any(r.get('result_sent') for r in records))


if __name__=='__main__':unittest.main()
