"""Real same-UID /proc reopen denial for Root-owned native protocol pipes."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
from codex_service.contract import Refused
from codex_service.native_io import create, validate


@unittest.skipUnless(os.geteuid() == 0, 'Root-created disposable protocol pipes')
class NativeIOTests(unittest.TestCase):
    def test_peer_executor_cannot_reopen_native_input_or_output(self):
        descriptors = create()
        child = None
        try:
            child = subprocess.Popen(['/usr/bin/cat'], stdin=descriptors[0], stdout=descriptors[3],
                stderr=subprocess.DEVNULL, user=65534, group=65534, extra_groups=[])
            script = '''import ctypes,os,sys
assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0
for slot,mode in ((0,os.O_WRONLY),(1,os.O_RDONLY)):
 try: fd=os.open('/proc/'+sys.argv[1]+'/fd/'+str(slot),mode|os.O_NONBLOCK)
 except PermissionError:pass
 else:os.close(fd);raise AssertionError('sibling native protocol exposed')
'''
            subprocess.run([sys.executable, '-I', '-S', '-B', '-c', script, str(child.pid)],
                user=65534, group=65534, extra_groups=[], check=True, capture_output=True,
                env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=3)
            os.write(descriptors[1], b'original Core writer still works\n')
            import select
            self.assertTrue(select.select([descriptors[2]], [], [], 2)[0])
            self.assertEqual(os.read(descriptors[2], 128), b'original Core writer still works\n')
        finally:
            if child is not None:
                child.kill(); child.wait(timeout=2)
            for fd in descriptors: os.close(fd)

    def test_alias_or_relaxed_custody_is_not_accepted_as_root_io(self):
        descriptors = create()
        try:
            with self.assertRaises(Refused): validate(descriptors[:2] * 2)
            os.fchmod(descriptors[0], 0o640)
            with self.assertRaises(Refused): validate(descriptors)
        finally:
            for fd in descriptors: os.close(fd)


if __name__ == '__main__': unittest.main()
