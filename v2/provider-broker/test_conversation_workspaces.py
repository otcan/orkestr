"""Closed shared workspace shape agrees between the packager and broker."""
import sys
from pathlib import Path
import unittest

from codex_service.package import conversation_workspace_paths
from codex_service.contract import Refused

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'packaging/service'))
from beta_config import conversation_workspaces

CID = '11111111-1111-4111-8111-111111111111'


class ConversationWorkspaces(unittest.TestCase):
    def config(self, value):
        return {'host_full_access': {}, 'conversation_workspaces': {CID: value}}

    def test_legacy_and_explicit_shared_paths_agree(self):
        for value in ['/srv/legacy-thread', {'path': '/srv/shared-thread', 'shared': True}]:
            beta = self.config(value)
            self.assertIs(conversation_workspaces(beta), beta)
            self.assertEqual(conversation_workspace_paths(beta),
                             (value if isinstance(value, str) else value['path'],))

    def test_unapproved_shape_or_path_never_becomes_a_pin(self):
        for value in [None, 7, {'path': '/srv/x'}, {'path': '/srv/x', 'shared': False},
                      {'path': '/srv/x', 'shared': 1}, {'path': '/srv/x', 'shared': True, 'extra': True},
                      {'path': '/', 'shared': True}, {'path': '/srv/../x', 'shared': True},
                      {'path': '/srv/x/', 'shared': True}]:
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    conversation_workspaces(self.config(value))
                with self.assertRaises(Refused):
                    conversation_workspace_paths(self.config(value))


if __name__ == '__main__':
    unittest.main()
