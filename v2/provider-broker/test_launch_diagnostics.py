"""Bounded failure metadata; no provider, credentials or operational service."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
from codex_service import entry


@unittest.skipUnless(os.geteuid()==0,'Root-owned diagnostic fixture')
class Tests(unittest.TestCase):
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='ork-launch-diag-',dir='/'));self.root.chmod(0o755)
        self.addCleanup(lambda:shutil.rmtree(self.root))
        path=self.root/'codex_service/entry.py';path.parent.mkdir()
        path.write_bytes(Path(entry.__file__).read_bytes());path.chmod(0o444)
        self.sha=hashlib.sha256(path.read_bytes()).hexdigest()
        (self.root/'manifest.json').write_text(json.dumps({'files':{'codex_service/entry.py':self.sha}}))
        spec=importlib.util.spec_from_file_location('fixture_entry',path)
        self.entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.entry)

    def exception(self):
        try:self.entry.document(self.root/'nonexistent-secret-path',100)
        except OSError as error:return error

    def test_metadata_has_only_static_class_errno_pinned_module_line(self):
        value=self.entry.failure_metadata(self.exception(),self.root)
        self.assertEqual(value['exception_class'],'FileNotFoundError');self.assertEqual(value['errno'],2)
        self.assertEqual(value['module'],'codex_service/entry.py');self.assertEqual(value['module_sha256'],self.sha)
        self.assertNotIn('nonexistent-secret-path',json.dumps(value))
        self.assertEqual(set(value),{'format','exception_class','errno','module','module_sha256','line'})

    def test_actual_root_parent_capsule_collects_dropped_child_report(self):
        parent,child=socket.socketpair();self.addCleanup(parent.close);self.addCleanup(child.close)
        pid=os.fork()
        if pid==0:
            try:
                parent.close();os.setgroups([]);os.setgid(65534);os.setuid(65534)
                sys.argv=['entry.py','launch-child','11',str(child.fileno())]
                self.entry.report_failure(self.exception())
            finally:os._exit(0)
        child.close();os.waitpid(pid,0)
        report=self.entry.receive_failure(parent,self.root)
        self.assertIsNotNone(report);self.assertEqual(report['module_sha256'],self.sha)

    def test_foreign_capsule_never_receives_a_report(self):
        parent,child=socket.socketpair();self.addCleanup(parent.close);self.addCleanup(child.close)
        # Same-process socket peer is not the child process's original parent.
        with patch.object(sys,'argv',['entry.py','launch-child','11',str(child.fileno())]):
            self.entry.report_failure(self.exception())
        parent.settimeout(.02)
        with self.assertRaises(TimeoutError):parent.recv(1)

    def read(self,value):
        a,b=socket.socketpair()
        try:
            a.sendall(value);a.shutdown(socket.SHUT_WR)
            return self.entry.receive_failure(b,self.root)
        finally:a.close();b.close()

    def test_closed_reader_rejects_extra_fields_unpinned_module_and_oversize(self):
        value=self.entry.failure_metadata(self.exception(),self.root)
        self.assertIsNotNone(self.read(json.dumps(value).encode()+b'\n'))
        for change in ({'message':'synthetic-secret'},{'module_sha256':'0'*64},{'module':'../escape.py'},
                       {'line':True},{'line':10**8},{'errno':True},{'exception_class':'synthetic-secret'}):
            bad={**value,**change};self.assertIsNone(self.read(json.dumps(bad).encode()+b'\n'))
        self.assertIsNone(self.read(b'x'*2049));self.assertIsNone(self.read(b'{'))

    def test_original_child_is_journaled_before_failure_cleanup(self):
        import ast
        source=Path(entry.__file__).with_name('launch.py').read_text();tree=ast.parse(source)
        launch=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='launch')
        journal=source.index("record['original_child']")
        self.assertLess(journal,source.index("require(time.monotonic()<deadline,'launch_pause_deadline')"))
        self.assertLess(source.index("record['failure']"),source.index('child.kill();'))
        self.assertIn("original['wait_status']=child.poll()",source)
        self.assertIn("record['cleanup_wait_status']=child.wait(timeout=2)",source)
