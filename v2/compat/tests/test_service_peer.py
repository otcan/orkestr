"""Actual kernel peer negatives; disposable Core/foreign UIDs, no real secrets."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sys
import threading
import unittest
import uuid

sys.path.insert(0,str(Path(__file__).parents[1]))
from v1_runtime.service_peer import Binding, Connection, PeerError
from peer_test_fixture import CorePeer
from test_service_client import Peer, OWNER


@unittest.skipUnless(os.geteuid()==0,'Root original-actor TCP fixture required')
class KernelPeerTests(unittest.TestCase):
    def setUp(self):
        self.root=Path('/orkestr-peer-test-'+str(uuid.uuid4()));self.root.mkdir(mode=0o755)
        self.addCleanup(shutil.rmtree,self.root)
        self.core=CorePeer(self.root,Peer);self.addCleanup(self.core.close)
        self.path=self.core.publish()

    def connection(self):
        return Connection('127.0.0.1',self.core.server_port,descriptor_path=str(self.path),owner=OWNER,source='a'*40,timeout=2)

    def test_exact_original_child_connection_can_send_synthetic_http(self):
        connection=self.connection();self.addCleanup(connection.close);connection.connect()
        connection.request('GET','/api/v2/health')
        response=connection.getresponse();value=json.loads(response.read());response.close()
        self.assertEqual(value['build']['source_commit'],'a'*40)
        self.assertTrue(connection.offered_bytes)

    def delayed_accept(self, delay):
        # A connection can enter the listener backlog before the original Core
        # accepts it. Keep that exact actor alive and resume it within the
        # caller's deadline; no substitute server is involved.
        os.kill(self.core._process.pid, signal.SIGSTOP)
        resume=threading.Timer(delay, os.kill, args=(self.core._process.pid, signal.SIGCONT))
        resume.start()
        self.addCleanup(resume.join)
        return resume

    def test_original_core_accept_after_one_second_uses_caller_deadline(self):
        connection=self.connection();self.addCleanup(connection.close)
        self.delayed_accept(1.3)
        connection.connect()
        connection.request('GET','/api/v2/health')
        response=connection.getresponse();value=json.loads(response.read());response.close()
        self.assertEqual(value['build']['source_commit'],'a'*40)
        self.assertTrue(connection.offered_bytes)

    def test_caller_deadline_still_refuses_without_offering_http_bytes(self):
        connection=Connection('127.0.0.1',self.core.server_port,descriptor_path=str(self.path),
                              owner=OWNER,source='a'*40,timeout=.1)
        self.addCleanup(connection.close)
        resume=self.delayed_accept(.4)
        with self.assertRaisesRegex(PeerError,'peer_accepted_socket_not_original_core'):
            connection.connect()
        self.assertFalse(connection.offered_bytes)
        resume.join()
        self.assertEqual(self.core.calls,[])

    def test_same_port_foreign_uid_spoof_gets_zero_http_or_secret_bytes(self):
        self.core.close_listener()
        spoof=CorePeer(self.root,Peer,uid=62122,port=self.core.server_port);self.addCleanup(spoof.close)
        # Spoof returns the exact same health/source/owner if spoken to; proof
        # must fail before asking it or offering a cookie/key/header/body.
        connection=self.connection();self.addCleanup(connection.close)
        with self.assertRaises(PeerError):connection.connect()
        self.assertFalse(connection.offered_bytes);self.assertEqual(spoof.calls,[])

    def test_original_peer_disappearing_after_connect_blocks_every_header_write(self):
        connection=self.connection();self.addCleanup(connection.close);connection.connect()
        self.core._process.terminate();self.core._process.wait(timeout=3)
        with self.assertRaises(PeerError):connection.request('POST','/synthetic',body=b'synthetic-key',headers={'Cookie':'synthetic-cookie'})
        self.assertFalse(connection.offered_bytes);self.assertEqual(self.core.calls,[])

    def test_original_peer_disappearing_before_body_write_does_not_offer_body(self):
        connection=self.connection();self.addCleanup(connection.close);connection.connect()
        connection.putrequest('POST','/synthetic');connection.putheader('Content-Length','13');connection.endheaders()
        self.assertTrue(connection.offered_bytes)
        self.core._process.terminate();self.core._process.wait(timeout=3)
        with self.assertRaises(PeerError):connection.send(b'synthetic-key')
        self.assertEqual(self.core.calls,[])

    def test_foreign_scope_and_stale_process_descriptor_fail_before_connect(self):
        for owner,source in [(str(uuid.uuid4()),'a'*40),(OWNER,'b'*40)]:
            with self.subTest(owner=owner,source=source),self.assertRaises(PeerError):
                Connection('127.0.0.1',self.core.server_port,descriptor_path=str(self.path),owner=owner,source=source,timeout=2)
        self.assertEqual(self.core.calls,[])
        self.core._process.terminate();self.core._process.wait(timeout=3)
        with self.assertRaises(PeerError):self.connection()

    def test_mutable_or_aliased_descriptor_refused_without_http(self):
        self.path.chmod(0o600)
        with self.assertRaises(PeerError):self.connection()
        self.path.chmod(0o400)
        alias=self.root/'alias';alias.symlink_to(self.path)
        with self.assertRaises(PeerError):Connection('127.0.0.1',self.core.server_port,descriptor_path=str(alias),owner=OWNER,source='a'*40,timeout=2)
        self.assertEqual(self.core.calls,[])


if __name__=='__main__':unittest.main()
