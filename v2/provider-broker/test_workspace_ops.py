"""Claim-journal failures, not a Core/native/cgroup acceptance oracle."""
import hashlib
import json
import os
from pathlib import Path
import socket
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

from codex_service.contract import Refused
from codex_service.workspace_ops import Operations
from test_workspace_command import cap


class WorkspaceClaimTests(unittest.TestCase):
    def test_claim_is_durable_before_fork_and_unknown_receipt_never_forks_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); conversation = str(uuid.uuid4()); owner = str(uuid.uuid4())
            source = 'printf synthetic'; capability = cap(source)
            request = dict(owner_id=owner, conversation_id=conversation,
                window_id=str(uuid.uuid4()), generation=1, capability=capability)
            profile = {'cgroup_root':'/synthetic-cgroup', 'trusted':{}}
            scope = (conversation, capability['project_id'])
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            parent, endpoint = socket.socketpair()
            out, output = os.pipe(); err, error = os.pipe()
            try:
                installation = SimpleNamespace(check=Mock(), paths=[directory]*3,
                    identities=[(1,2,3)]*3, fds=[fd]*3)
                job = SimpleNamespace(fd=fd, kill=Mock(), empty=Mock(return_value=True), close_empty=Mock())
                group = SimpleNamespace(job=Mock(return_value=job))
                operation = Operations.__new__(Operations)
                operation.package = SimpleNamespace(owner=owner, root=directory)
                operation.manager = SimpleNamespace(launcher=object(), identity={'pid':123,'start':456})
                operation.projects = SimpleNamespace(profiles={scope:profile}, installations={scope:installation})
                operation.directory=directory; operation.roots={profile['cgroup_root']:group}
                operation.active={}; operation.faulted=False; operation.identity={'start':1}
                operation.descriptors=Mock()
                selected=SimpleNamespace(kind='command')
                path=directory/(capability['operation_id']+'.json')
                def fail_after_claim(*args, **kwargs):
                    row=json.loads(path.read_text())
                    self.assertEqual(row['state'],'claimed')
                    self.assertEqual(row['source_sha256'],hashlib.sha256(source.encode()).hexdigest())
                    self.assertFalse(row['cleanup'])
                    self.assertEqual(path.stat().st_mode&0o777,0o600)
                    raise OSError('synthetic pre-fork failure')
                with patch('codex_service.workspace_ops.sealed_source',return_value=(source,selected)), \
                     patch('codex_service.workspace_ops.worker_parent',return_value=SimpleNamespace(broker={})), \
                     patch('codex_service.workspace_ops.subprocess.Popen',side_effect=fail_after_claim) as spawn:
                    with self.assertRaisesRegex(OSError,'pre-fork failure'):
                        operation.start(request,[fd,output,error,endpoint.fileno()])
                    self.assertEqual(spawn.call_count,1)
                    receipt=operation.start(request,[fd,output,error,endpoint.fileno()])
                    self.assertEqual(receipt['state'],'unknown');self.assertFalse(receipt['cleanup'])
                    self.assertEqual(spawn.call_count,1)
                    self.assertFalse(operation.window_clean(request['window_id']))
                    changed={**request,'generation':2}
                    with self.assertRaisesRegex(Refused,'replay_conflict'):
                        operation.start(changed,[fd,output,error,endpoint.fileno()])
                    self.assertEqual(spawn.call_count,1)
            finally:
                parent.close();endpoint.close()
                for value in (fd,out,output,err,error):os.close(value)


if __name__=='__main__':unittest.main()
