"""Consumed-scope/source parser tests; no Core input or business dispatch."""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from codex_service.contract import Refused
from codex_service.workspace_command import capability, operation, sealed_source, parent


def cap(source='printf synthetic'):
    return {**{field: str(uuid.uuid4()) for field in ('operation_id', 'project_id', 'run_id', 'session_id')},
        'project_generation': 1, 'binding_generation': 7, 'lease_generation': 1, 'dispatch_fence': 1,
        'context_id': 'synthetic-context', 'incarnation': 'synthetic-incarnation',
        'source_sha256': hashlib.sha256(source.encode()).hexdigest(), 'expires_at_ms': int(time.time()*1000)+20000}


class WorkspaceCommandTests(unittest.TestCase):
    def test_closed_consumed_metadata_and_only_canonical_job_operations(self):
        capability(cap())
        for field in ('project_generation', 'lease_generation', 'dispatch_fence'):
            value = cap(); value[field] = 0
            with self.assertRaises(Refused): capability(value)
        for field in ('path', 'command', 'environment', 'executor_uid'):
            with self.assertRaisesRegex(Refused, 'workspace_command_capability_fields'):
                capability({**cap(), field: 'untrusted'})
        target = str(uuid.uuid4())
        self.assertEqual(operation('printf synthetic').kind, 'command')
        self.assertEqual(operation('#!orkestr-job start\nprintf synthetic').command, 'printf synthetic')
        for action in ('status', 'wait', 'cancel'):
            selected = operation('#!orkestr-job ' + action + ' ' + target)
            self.assertEqual((selected.kind, selected.target), (action, target))
        for source in ('#!orkestr-job start\n', '#!orkestr-job status ../other', '#!orkestr-job kill ' + target):
            with self.assertRaises(Refused): operation(source)

    def test_source_requires_immutable_memfd_and_exact_actual_consumed_digest(self):
        fd = os.memfd_create('synthetic-workspace-source', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        try:
            source = b'printf synthetic'; os.write(fd, source); expected = cap(source.decode())
            with self.assertRaisesRegex(Refused, 'workspace_command_source_not_sealed'): sealed_source(fd, expected)
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, 15)
            raw, selected = sealed_source(fd, expected)
            self.assertEqual(raw, source.decode()); self.assertEqual(selected.kind, 'command')
            with self.assertRaises(OSError): os.pwrite(fd, b'changed', 0)
            with self.assertRaisesRegex(Refused, 'workspace_command_source_digest'):
                sealed_source(fd, {**expected, 'source_sha256': '0'*64})
        finally: os.close(fd)

    def test_worker_source_must_match_actual_active_launch_session_incarnation_and_window(self):
        value = cap(); owner, conversation, window = (str(uuid.uuid4()) for _ in range(3))
        request = {'capability': value, 'owner_id': owner, 'conversation_id': conversation,
                   'window_id': window, 'generation': 2}
        setup = dict(owner_id=owner, conversation_id=conversation, role='worker', provider='codex',
                     session_id=value['session_id'], incarnation=value['incarnation'], generation=6)
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary) / 'launch.json'
            handle = SimpleNamespace(path=record, window=window, generation=2,
                child=SimpleNamespace(poll=lambda: None), broker={'synthetic': True})
            launcher = SimpleNamespace(children={'synthetic': handle})
            with patch('codex_service.workspace_command.exists', return_value=True):
                record.write_text(json.dumps({'state': 'spawned', 'mode': 'fresh', 'setup': setup,'workspace_worker':True}))
                self.assertIs(parent(launcher, request), handle)
                for field, invalid in (('role', 'deep'), ('provider', 'claude'), ('session_id', str(uuid.uuid4())),
                                       ('incarnation', 'other'), ('generation', 8)):
                    changed = copy.deepcopy(setup); changed[field] = invalid
                    record.write_text(json.dumps({'state': 'spawned', 'mode': 'fresh', 'setup': changed,'workspace_worker':True}))
                    with self.assertRaisesRegex(Refused, 'workspace_command_worker_lineage'): parent(launcher, request)
                record.write_text(json.dumps({'state':'spawned','mode':'fresh','setup':setup}))
                with self.assertRaisesRegex(Refused,'workspace_command_worker_lineage'):parent(launcher,request)


if __name__ == '__main__': unittest.main()
