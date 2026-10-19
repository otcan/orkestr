"""Actual immutable Package policy parsing; synthetic account metadata only."""
import copy
import json
import os
import unittest
from pathlib import Path
from codex_bounded.configuration import Package
from codex_bounded.trust import Refused,digest
from selected_codex_fixture import Fixture

@unittest.skipUnless(os.geteuid()==0,'protected package fixture requires root')
class WorkspacePolicyTests(unittest.TestCase):
    def test_actual_package_closed_policy_and_default(self):
        f=Fixture()
        try:
            f.prepare();root=Path(f.receipt['package'])
            Package(root) # unchanged default remains supported
            path=f.home/'selected-execution.json'
            original=json.loads(path.read_text())
            policy={'project_id':'11111111-2222-4333-8444-555555555555',
                    'allowed_roots':[str(f.workspace)],'protected_roots':[str(f.home)]}
            def write(value):
                f.write_private(path,json.dumps(value).encode())
                f.alter('runtime.json',lambda r:r.update(execution_config_sha256=digest(path)))
            valid={**original,'workspace_authority':policy}
            write(valid);Package(root)
            cases=[None,{}, {**policy,'extra':True}, {**policy,'project_id':'bad'},
                   {**policy,'project_id':'00000000-0000-0000-0000-000000000000'},
                   {**policy,'allowed_roots':[]},{**policy,'allowed_roots':['relative']},
                   {**policy,'protected_roots':['/a/../b']},
                   {**policy,'allowed_roots':['/bad\npath']},
                   {**policy,'protected_roots':'/private'}]
            for candidate in cases[1:]:
                with self.subTest(candidate=candidate):
                    write({**original,'workspace_authority':candidate})
                    with self.assertRaises(Refused):Package(root)
            write(valid)
            with self.assertRaisesRegex(Refused,'workspace_descriptor_type'):
                Package(root,workspace_descriptor=object())
            write(original)
            with self.assertRaisesRegex(Refused,'workspace_opt_in_required'):
                Package(root,workspace_descriptor=object())
        finally:f.close()
