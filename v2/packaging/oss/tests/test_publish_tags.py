"""The V2 publish can never write :latest, :main or a V1 tag."""
import importlib.util
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parents[1]
WORKFLOW = HERE.parents[2] / '.github/workflows/v2-publish.yml'
spec = importlib.util.spec_from_file_location('oss_publish_tags', HERE / 'publish_tags.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublishTagTests(unittest.TestCase):
    def test_release_tag_and_arch_tags(self):
        value = publish.tags('v2.0.0-beta.6', '2.0.0-beta.6')
        self.assertEqual(value['image'], 'ghcr.io/otcan/orkestr')
        self.assertEqual(value['tag'], 'v2.0.0-beta.6')
        self.assertEqual(value['arch_tags'], {'amd64': 'v2.0.0-beta.6-amd64', 'arm64': 'v2.0.0-beta.6-arm64'})
        self.assertFalse(value['candidate'])

    def test_candidate_tag(self):
        value = publish.tags('v2.0.0-beta.6-rc.1', '2.0.0-beta.5')
        self.assertTrue(value['candidate'])
        self.assertEqual(value['arch_tags']['arm64'], 'v2.0.0-beta.6-rc.1-arm64')

    def test_release_tag_must_match_the_workspace_version(self):
        with self.assertRaises(ValueError):
            publish.tags('v2.0.0-beta.6', '2.0.0-beta.5')

    def test_floating_v1_and_foreign_refs_refused(self):
        for ref in ('latest', 'main', 'stable', 'v2/rust-rewrite', 'v0.1.0-alpha.99', 'v0.2.0', 'v1.0.0',
                    'v2.0.0', 'v2.0.0-rc.1', 'v2.1.0-beta.1', 'v2.0.0-beta.6-latest', 'sha-abcdef123456',
                    'v2.0.0-beta.06', 'v2.0.0-beta.6 ', 'v2.0.0-beta.6\nlatest', ''):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                publish.tags(ref, '2.0.0-beta.6')
        for tag in ('latest', 'main', 'v0.1.0-alpha.99', 'v0.1.0-alpha.99-amd64', 'sha-abc', 'v2.0.0-beta.6-arm'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                publish.assert_v2_tag(tag)

    def test_check_refuses_tags_outside_the_computed_set(self):
        self.assertEqual(publish.main(['check', 'v2.0.0-beta.6-amd64', '["v2.0.0-beta.6-amd64"]']), 0)
        with self.assertRaises(ValueError):
            publish.main(['check', 'v2.0.0-beta.7-amd64', '["v2.0.0-beta.6-amd64"]'])

    def test_workflow_only_runs_for_v2_beta_tags_and_never_floats(self):
        text = WORKFLOW.read_text()
        self.assertNotIn('latest', text.replace('ubuntu-latest', ''))
        self.assertNotRegex(text, r'(?m)^\s*(branches|pull_request|schedule|merge_group)\b')
        self.assertIn("tags: ['v2.0.0-beta.*']", text)
        self.assertNotRegex(text, r':main\b|\bsha-')
        # Every push/tag-writing command is preceded by a publish_tags.py check.
        for block in re.findall(r'run: \|\n((?:\s{10}.*\n)+)', text):
            if '--push' in block or 'imagetools create' in block:
                self.assertIn('publish_tags.py check', block)
                self.assertLess(block.index('publish_tags.py check'),
                                block.index('--push' if '--push' in block else 'imagetools create'))
        self.assertEqual(text.count('--push'), 1)
        self.assertEqual(text.count('imagetools create'), 1)


if __name__ == '__main__':
    unittest.main()
