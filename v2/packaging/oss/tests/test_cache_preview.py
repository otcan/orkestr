"""Only verified same-ref content-addressed layers can reduce an export budget."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'cache_budget_preview', Path(__file__).resolve().parents[1] / 'cache_budget.py')
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)
REF = 'refs/heads/build-candidate'


def fixture(root, duplicate=False, media='application/vnd.oci.image.layer.v1.tar+gzip'):
    blobs = root / 'blobs/sha256'
    blobs.mkdir(parents=True)

    def put(data, kind):
        digest = hashlib.sha256(data).hexdigest()
        (blobs / digest).write_bytes(data)
        return {'mediaType': kind, 'size': len(data), 'digest': 'sha256:' + digest}

    layer = put(gzip.compress(b'generic sealed build output', mtime=0), media)
    config = put(b'{"layers":[],"records":[]}', 'application/vnd.buildkit.cacheconfig.v0')
    manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                'config': config, 'layers': [layer, layer] if duplicate else [layer]}
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

    def test_duplicate_descriptors_and_unknown_compression_fail_closed(self):
        for kwargs in [{'duplicate': True}, {'media': 'application/vnd.oci.image.layer.v1.tar+zstd'}]:
            with tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                layer = fixture(root, **kwargs)
                with self.assertRaises(ValueError):
                    budget.preview_inventory(root, observed(layer))


if __name__ == '__main__':
    unittest.main()
