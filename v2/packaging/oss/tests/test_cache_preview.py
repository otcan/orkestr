"""Only verified same-ref content-addressed layers can reduce an export budget."""
import gzip
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

SPEC = importlib.util.spec_from_file_location(
    'cache_budget_preview', Path(__file__).resolve().parents[1] / 'cache_budget.py')
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)
REF = 'refs/heads/build-candidate'


def fixture(root, duplicate=False, conflict=False, media='application/vnd.oci.image.layer.v1.tar+gzip'):
    blobs = root / 'blobs/sha256'
    blobs.mkdir(parents=True)

    def put(data, kind):
        digest = hashlib.sha256(data).hexdigest()
        (blobs / digest).write_bytes(data)
        return {'mediaType': kind, 'size': len(data), 'digest': 'sha256:' + digest}

    layer = put(gzip.compress(b'generic sealed build output', mtime=0), media)
    config = put(b'{"layers":[],"records":[]}', 'application/vnd.buildkit.cacheconfig.v0')
    layers = [layer, {**layer, 'size': layer['size'] + 1}] if conflict else [layer, layer] if duplicate else [layer]
    manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                'config': config, 'layers': layers}
    descriptor = put(json.dumps(manifest).encode(), manifest['mediaType'])
    (root / 'index.json').write_text(json.dumps({'schemaVersion': 2,
        'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [descriptor]}))
    return layer


def observed(layer, ref=REF, version=None, prefix=None, duplicate=False):
    row = {'id': 1, 'key': (prefix or budget.BLOB_PREFIX) + layer['digest'][7:],
           'ref': ref, 'version': version or budget.CACHE_VERSION, 'size_in_bytes': layer['size']}
    rows = [row, {**row, 'id': 2}] if duplicate else [row]
    replies = iter([{'active_caches_size_in_bytes': 0},
                    {'total_count': len(rows), 'actions_caches': rows}])
    return budget.observed_usage(lambda _: next(replies), REF)['_visible_blob_sizes']


class CachePreviewTests(unittest.TestCase):
    def run_main(self, root, argv):
        env = {'GITHUB_REPOSITORY': 'owner/product', 'GITHUB_REF': REF,
               'GH_TOKEN': 'synthetic-sensitive-token', 'GITHUB_OUTPUT': str(root / 'output')}
        output = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch('sys.argv', ['cache_budget.py', *argv]), redirect_stdout(output):
            budget.main()
        self.assertNotIn('synthetic-sensitive-token', output.getvalue())
        return json.loads((root / 'report.json').read_text())

    def test_http_failure_reports_status_once_without_response_or_token(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            error = urllib.error.HTTPError('https://api.github.com/', 403, 'refused', {},
                                          io.BytesIO(b'synthetic-sensitive-body'))
            with patch.object(budget.urllib.request, 'urlopen', side_effect=error) as request:
                report = self.run_main(root, ['--prepare', '--report', str(root / 'report.json')])
            self.assertEqual(request.call_count, 1)
            self.assertFalse(report['export_allowed'])
            self.assertEqual(report['http_status'], 403)
            self.assertNotIn('synthetic-sensitive-body', json.dumps(report))

    def test_actual_preview_refusal_retains_its_static_validation_code(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            fixture(root / 'preview', conflict=True)
            usage = {'repository_cache_bytes': 0, '_visible_blob_sizes': {}}
            with patch.object(budget, 'observed_usage', return_value=usage):
                report = self.run_main(root, ['--preview', str(root / 'preview'),
                    '--allocation', '100000000', '--report', str(root / 'report.json')])
            self.assertFalse(report['export_allowed'])
            self.assertEqual(report['validation_code'], 'cache_descriptor_size_mismatch')
            self.assertEqual(report['preview_layer_media_types'], ['application/vnd.oci.image.layer.v1.tar+gzip'])

    def test_exact_visible_layer_is_counted_once_not_recharged(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            layer = fixture(root)
            total, already = budget.preview_inventory(root, observed(layer))
            self.assertEqual(already, layer['size'])
            allowance = total - already + 64 * 1024 ** 2
            self.assertTrue(budget.decide(0, total, allowance, already)['export_allowed'])
            self.assertFalse(budget.decide(0, total, allowance)['export_allowed'])

    def test_foreign_ref_unknown_namespace_and_unknown_version_get_no_discount(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            layer = fixture(root)
            for kwargs in [{'ref': 'refs/heads/another-branch'}, {'version': 'unknown'},
                           {'prefix': 'buildkit-blob-2-sha256:'}]:
                with self.subTest(kwargs=kwargs):
                    self.assertEqual(budget.preview_inventory(root, observed(layer, **kwargs))[1], 0)

    def test_duplicate_current_ref_keys_are_ambiguous_even_with_equal_sizes(self):
        with tempfile.TemporaryDirectory() as scratch:
            layer = fixture(Path(scratch))
            with self.assertRaisesRegex(ValueError, 'duplicate current-ref'):
                observed(layer, duplicate=True)

    def test_same_size_corruption_cannot_claim_an_existing_digest(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            layer = fixture(root)
            (root / 'blobs/sha256' / layer['digest'][7:]).write_bytes(b'x' * layer['size'])
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                budget.preview_inventory(root, observed(layer))

    def test_existing_size_mismatch_and_symlinks_fail_closed(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            layer = fixture(root)
            with self.assertRaisesRegex(ValueError, 'existing blob size'):
                budget.preview_inventory(root, {layer['digest'][7:]: layer['size'] + 1})
            path = root / 'blobs/sha256' / layer['digest'][7:]
            path.unlink()
            path.symlink_to(root / 'index.json')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                budget.preview_inventory(root, observed(layer))

    def test_repeated_verified_layer_is_discounted_once(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            layer = fixture(root, duplicate=True)
            total, already = budget.preview_inventory(root, observed(layer))
            self.assertEqual(already, layer['size'])
            self.assertGreater(total, already)

    def test_conflicting_descriptors_and_unknown_compression_fail_closed(self):
        for kwargs in [{'conflict': True}, {'media': 'application/vnd.oci.image.layer.v1.tar+zstd'}]:
            with tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                layer = fixture(root, **kwargs)
                with self.assertRaises(ValueError):
                    budget.preview_inventory(root, observed(layer))


if __name__ == '__main__':
    unittest.main()
