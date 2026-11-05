"""Root project transfer unit oracle; exact Core HTTP is a separate gate."""
import array
import hashlib
import json
import os
import socket
import struct
import subprocess
import time
import unittest
import uuid

from codex_bounded.trust import process
from codex_service.contract import Refused
from codex_service.contract import encode, decode, canonical
from codex_service.channel import receive_control
from codex_service.workspace_setup import Projects
import test_workspace_custody as custody
from codex_service_fixture import UID, GID


@unittest.skipUnless(os.geteuid() == 0, 'root-only disposable FD fixture')
class WorkspaceSetupTests(unittest.TestCase):
    def setUp(self):
        custody.WorkspaceCustodyTests.setUp(self)
        self.package.authority_uid = os.geteuid()  # Unit peer, not split Core qualification.
        self.package.owner = str(uuid.uuid4())
        self.package.beta = {'workspace_exec': self.profile}
        self.projects = Projects(self.package); self.addCleanup(self.projects.close)
        self.request = {'request_id': 'synthetic-project', 'owner_id': self.package.owner,
            'conversation_id': self.profile['conversation_id'], 'project_id': self.profile['project_id']}

    def transfer(self, request=None):
        sender, receiver = socket.socketpair()
        with sender, receiver:
            receipt = self.projects.attest(process(os.getpid()), request or self.request, sender.fileno())
            packet, ancillary, flags, _ = receiver.recvmsg(16388, socket.CMSG_SPACE(3 * 4), socket.MSG_CMSG_CLOEXEC)
            self.assertEqual(flags & ~socket.MSG_CMSG_CLOEXEC, 0)
            descriptors = []
            for level, kind, raw in ancillary:
                self.assertEqual((level, kind), (socket.SOL_SOCKET, socket.SCM_RIGHTS))
                values = array.array('i'); values.frombytes(raw); descriptors.extend(values)
            try:
                self.assertEqual(len(descriptors), 3)
                size = struct.unpack('!I', packet[:4])[0]
                self.assertEqual(size, len(packet) - 4)
                value = json.loads(packet[4:])
                self.assertEqual(receipt['attestation_sha256'], hashlib.sha256(packet[4:]).hexdigest())
                for identity, fd in zip(value['identities'], descriptors):
                    meta = os.fstat(fd); self.assertEqual(identity, [meta.st_dev, meta.st_ino, meta.st_uid])
                self.assertEqual(value['project_id'], self.profile['project_id'])
                self.assertEqual(receiver.recv(1), b'')
                return value
            finally:
                for fd in descriptors: os.close(fd)

    def test_authenticated_local_peer_receives_only_exact_retained_descriptors(self):
        first = self.transfer(); self.assertEqual(first, self.transfer())
        self.git.rename(self.workspace / '.retired-git')
        self.git.mkdir(mode=0o700); os.chown(self.git, UID, GID)
        with self.assertRaisesRegex(Refused, 'workspace_managed_replaced'): self.transfer()

    def test_owner_and_conversation_cannot_select_another_installation(self):
        for key in ('owner_id', 'conversation_id', 'project_id'):
            changed = {**self.request, key: str(uuid.uuid4())}
            with self.assertRaisesRegex(Refused, 'workspace_owner_scope|workspace_profile_scope'):
                self.transfer(changed)
        self.assertFalse(self.projects.installations)

    def test_closed_control_port_accepts_exactly_one_transfer_endpoint(self):
        request = {**self.request, 'version': 1, 'operation': 'workspace_attest'}
        for count in (0, 1, 2):
            sender, receiver = socket.socketpair()
            endpoint, other = socket.socketpair()
            with sender, receiver, endpoint, other:
                sender.sendmsg([encode(request)], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                    array.array('i', [endpoint.fileno()] * count))] if count else [])
                if count == 1:
                    decoded, descriptors = receive_control(receiver, time.monotonic() + 1)
                    try: self.assertEqual(decoded, request); self.assertEqual(len(descriptors), 1)
                    finally:
                        for fd in descriptors: os.close(fd)
                else:
                    with self.assertRaisesRegex(Refused, 'control_descriptor_count'):
                        receive_control(receiver, time.monotonic() + 1)
        for key in ('paths', 'command', 'uid', 'environment', 'capability'):
            with self.assertRaisesRegex(Refused, 'fields'):
                decode(canonical({**request, key: 'untrusted'}))

    def test_transfer_socket_must_come_from_the_original_source_process(self):
        child = subprocess.Popen(['/usr/bin/sleep', '2'], env={}, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sender, receiver = socket.socketpair()
        try:
            with sender, receiver:
                with self.assertRaisesRegex(Refused, 'workspace_transfer_source'):
                    self.projects.attest(process(child.pid), self.request, sender.fileno())
            self.assertFalse(self.projects.installations)
        finally: child.terminate(); child.wait(timeout=2)


if __name__ == '__main__': unittest.main()
