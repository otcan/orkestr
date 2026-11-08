"""Real accepted peer, transient observation misses, no HTTP request replay."""
import json
import os
from pathlib import Path
import shutil
import sys
import time
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).parents[1]))
from v1_runtime.service_peer import Connection, PeerError
from peer_test_fixture import CorePeer
from test_service_client import Peer, OWNER


@unittest.skipUnless(os.geteuid() == 0, 'Root original-actor TCP fixture required')
class PeerHandoffTests(unittest.TestCase):
    def setUp(self):
        self.root = Path('/orkestr-peer-handoff-' + str(uuid.uuid4()));self.root.mkdir(mode=0o755)
        self.addCleanup(shutil.rmtree, self.root)
        self.core = CorePeer(self.root, Peer);self.addCleanup(self.core.close)
        self.path = self.core.publish()

    def connection(self, timeout=2):
        value = Connection('127.0.0.1', self.core.server_port, descriptor_path=str(self.path),
                           owner=OWNER, source='a' * 40, timeout=timeout)
        self.addCleanup(value.close);value.connect();return value

    def missing_reverse_row(self, connection, always=False):
        original = Path.read_text
        wanted = ('0100007F:' + format(self.core.server_port, '04X'),
                  '0100007F:' + format(connection.sock.getsockname()[1], '04X'))
        observed = []
        def read(path, *args, **kwargs):
            raw = original(path, *args, **kwargs)
            if str(path) != '/proc/net/tcp' or (observed and not always):return raw
            lines = raw.splitlines();kept = [lines[0]]
            for line in lines[1:]:
                fields = line.split()
                if tuple(fields[1:3]) == wanted:
                    observed.append(fields[9]);continue
                kept.append(line)
            return '\n'.join(kept) + '\n'
        return read, observed

    def read_health(self, connection):
        connection.request('GET', '/api/v2/health')
        response = connection.getresponse()
        try:self.assertEqual(json.loads(response.read())['build']['source_commit'], 'a' * 40)
        finally:response.close()

    def test_post_connect_reverse_snapshot_miss_reproves_same_socket_before_headers(self):
        connection = self.connection();retained = connection.sock
        read, missed = self.missing_reverse_row(connection)
        with patch.object(Path, 'read_text', read), patch.object(connection.binding, 'verify', wraps=connection.binding.verify) as proof:
            self.read_health(connection)
        self.assertEqual(len(missed), 1);self.assertIs(proof.call_args[0][0], retained)
        self.assertTrue(connection.offered_bytes);self.assertEqual(self.core.calls, [('GET', '/api/v2/health', None)])

    def test_post_connect_core_fd_observation_miss_reproves_original_owner(self):
        connection = self.connection();original = os.readlink;missed = []
        prefix = '/proc/' + str(self.core._process.pid) + '/fd/'
        wanted = ('0100007F:' + format(self.core.server_port, '04X'),
                  '0100007F:' + format(connection.sock.getsockname()[1], '04X'))
        inode = next(fields[9] for line in Path('/proc/net/tcp').read_text().splitlines()[1:]
                     if len(fields := line.split()) >= 10 and tuple(fields[1:3]) == wanted and fields[3] == '01')
        def readlink(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            if str(path).startswith(prefix) and value == 'socket:[' + inode + ']' and not missed:
                missed.append(value);return 'socket:[0]'
            return value
        with patch.object(os, 'readlink', readlink):self.read_health(connection)
        self.assertEqual(len(missed), 1);self.assertTrue(connection.offered_bytes)
        self.assertEqual(self.core.calls, [('GET', '/api/v2/health', None)])

    def test_missing_proof_cannot_restart_budget_after_connect(self):
        connection = self.connection(timeout=.3)
        time.sleep(.2)
        read, missed = self.missing_reverse_row(connection, always=True)
        started = time.monotonic()
        with patch.object(Path, 'read_text', read), self.assertRaises(PeerError):
            connection.request('GET', '/api/v2/health')
        self.assertLess(time.monotonic() - started, .2)
        self.assertTrue(missed);self.assertFalse(connection.offered_bytes);self.assertEqual(self.core.calls, [])

    def test_expired_original_proof_budget_blocks_headers_even_with_valid_peer(self):
        connection = self.connection(timeout=.1);time.sleep(.15)
        with self.assertRaises(PeerError):connection.request('GET', '/api/v2/health')
        self.assertFalse(connection.offered_bytes);self.assertEqual(self.core.calls, [])

    def test_explicit_transport_deadline_cannot_be_renewed_by_binding_construction(self):
        connection = Connection('127.0.0.1', self.core.server_port, descriptor_path=str(self.path),
            owner=OWNER, source='a' * 40, timeout=2, deadline=time.monotonic() + .1)
        self.addCleanup(connection.close);time.sleep(.15)
        with self.assertRaisesRegex(PeerError, 'peer_proof_deadline_expired'):connection.connect()
        self.assertFalse(connection.offered_bytes);self.assertEqual(self.core.calls, [])

    def test_same_uid_foreign_process_cannot_own_the_accepted_connection(self):
        self.core.close_listener()
        root = self.root / 'foreign';root.mkdir(mode=0o755)
        foreign = CorePeer(root, Peer, uid=62121, port=self.core.server_port);self.addCleanup(foreign.close)
        connection = Connection('127.0.0.1', self.core.server_port, descriptor_path=str(self.path),
                                owner=OWNER, source='a' * 40, timeout=.2)
        self.addCleanup(connection.close)
        with self.assertRaises(PeerError):connection.connect()
        self.assertFalse(connection.offered_bytes);self.assertEqual(foreign.calls, [])

    def test_pre_body_snapshot_miss_reproves_without_resending_headers(self):
        connection = self.connection();body = b'{"synthetic":true}'
        connection.putrequest('POST', '/synthetic')
        connection.putheader('Content-Length', str(len(body)));connection.endheaders()
        read, missed = self.missing_reverse_row(connection)
        with patch.object(Path, 'read_text', read):connection.send(body)
        response = connection.getresponse()
        try:self.assertEqual(response.status, 404);response.read()
        finally:response.close()
        self.assertEqual(len(missed), 1)
        self.assertEqual(self.core.calls, [('POST', '/synthetic', {'synthetic': True})])


if __name__ == '__main__':unittest.main()
