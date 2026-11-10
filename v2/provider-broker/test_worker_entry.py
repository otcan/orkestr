"""Inventory-only fixed Worker entry; no provider/configuration access."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class WorkerEntryTests(unittest.TestCase):
    def test_inventory_is_complete_and_wrong_argv_refuses_before_config(self):
        source=Path(__file__).parent
        manifest=json.loads((source/'worker-package.json').read_text())
        with tempfile.TemporaryDirectory(prefix='synthetic-worker-package-') as directory:
            stage=Path(directory)
            for name,digest in manifest['files'].items():
                self.assertEqual(hashlib.sha256((source/name).read_bytes()).hexdigest(),digest)
                shutil.copy(source/name,stage/name)
            subprocess.run(['/usr/bin/python3','-c',
                'import worker_server,offline_route,offline_tool'],cwd=stage,
                env={'PATH':'/usr/bin:/bin'},check=True,timeout=3,capture_output=True)
            for argv in ([],['open-owned-session','--protocol','orkestr-v2-provider-broker-v1'],
                         ['open-owned-worker-session','--protocol','orkestr-v2-provider-broker-v1','--config','synthetic']):
                result=subprocess.run(['/usr/bin/python3',str(stage/'worker_server.py'),*argv],
                    cwd=stage,env={'PATH':'/usr/bin:/bin'},timeout=3,capture_output=True)
                self.assertEqual(result.returncode,2)
                self.assertEqual(result.stdout,b'');self.assertEqual(result.stderr,b'')
