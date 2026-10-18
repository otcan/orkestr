"""A failed successor copy preflight must never upgrade the original working home."""
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import cross_revision as probe


class UpgradeOrderTests(unittest.TestCase):
    def test_copy_failure_preserves_original_selection(self):
        with tempfile.TemporaryDirectory() as raw:
            args=SimpleNamespace(old_schema=17,new_schema=28,old_binary='/old',new_binary='/new',old_sha256='a'*64,new_sha256='b'*64,old_source='c'*40,new_source='d'*40,parent=raw,port=19842,sqlx_checksums={'1':'e'*96})
            upgraded=[]
            def invoke(entry,command,home,*extra,**kwargs):
                if command=='install':
                    (home/'control').mkdir(parents=True);(home/'data').mkdir()
                    (home/'control/bootstrap.token').write_text('synthetic')
                    (home/'data/core.sqlite3').write_text('synthetic old DB')
                if command=='upgrade':upgraded.append(home)
            def digest(path):
                return 'a'*64 if str(path)=='/old' else 'b'*64 if str(path)=='/new' else 'e'*64
            child=Mock();child.wait.return_value=0
            metadata={'version':'synthetic','source_commit':'f'*40,'target':'linux-x86_64'}
            with patch.object(probe,'sha256',side_effect=digest),patch.object(probe,'selected_package',side_effect=[Path('/old-package'),Path('/new-package')]),patch.object(probe.builder,'package',return_value=(Path('/package'),metadata)),patch.object(probe,'invoke',side_effect=invoke),patch.object(probe,'Client'),patch.object(probe,'launch',side_effect=[child,RuntimeError('synthetic preflight refusal')]),patch.object(probe,'smoke',return_value=('/conversation',{},{})),patch.object(probe,'verify_schema'),patch.object(probe,'copy_home',side_effect=shutil.copytree):
                with self.assertRaisesRegex(RuntimeError,'preflight refusal'):probe.exercise(args)
            self.assertEqual([path.name for path in upgraded],['preflight-copy'])
            self.assertFalse(any(path.name=='working' for path in upgraded))
            root=next(Path(raw).glob('v2-upgrade-*'))
            self.assertEqual((root/'working/data/core.sqlite3').read_text(),'synthetic old DB')
            self.assertEqual((root/'rollback/data/core.sqlite3').read_text(),'synthetic old DB')
