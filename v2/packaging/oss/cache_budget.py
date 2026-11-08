"""Conservative, read-only admission for two native GHA cache exporters.

Never deletes caches or changes the repository's storage/billing settings.
Unknown usage disables export while the ordinary image checks still run.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import urllib.request

LIMIT = 10 * 1024 ** 3
RESERVE = 1024 ** 3
EXPORTERS = 2
# BuildKit gha.go v0.34.2 and go-actions-cache afe8013b5ac4 version(k).
# Unknown namespaces/versions are charged in full rather than discounted.
BLOB_PREFIX = 'buildkit-blob-1-sha256:'
CACHE_VERSION = hashlib.sha256(b'|go-actionscache-1.0').hexdigest()
SHA256 = re.compile(r'sha256:([0-9a-f]{64})\Z')


def observed_usage(fetch, current_ref=None):
    """Aggregate usage can lag uploads; reconcile a bounded complete listing."""
    aggregate = fetch('/actions/cache/usage')['active_caches_size_in_bytes']
    allocation(aggregate)
    identities, listed, expected, visible = set(), 0, None, {}
    own_keys = set()
    for page in range(1, 11):
        data = fetch('/actions/caches?per_page=100&page=' + str(page))
        total, rows = data['total_count'], data['actions_caches']
        if type(total) is not int or not 0 <= total <= 1000 or not isinstance(rows, list) or len(rows) > 100:
            raise ValueError('unknown cache listing shape')
        if expected is not None and total != expected:
            raise ValueError('cache listing changed during pagination')
        expected = total
        for row in rows:
            identity, size = row['id'], row['size_in_bytes']
            if type(identity) is not int or identity <= 0 or identity in identities or type(size) is not int or size < 0:
                raise ValueError('ambiguous cache listing entry')
            identities.add(identity)
            listed += size
            key = row.get('key', '')
            if current_ref and row.get('ref') == current_ref and isinstance(key, str) and key.startswith(BLOB_PREFIX):
                if key in own_keys:
                    raise ValueError('duplicate current-ref blob key')
                own_keys.add(key)
                digest = key[len(BLOB_PREFIX):]
                if re.fullmatch('[0-9a-f]{64}', digest) and row.get('version') == CACHE_VERSION:
                    visible[digest] = size
        if len(identities) == total:
            return {'aggregate_cache_bytes': aggregate, 'listed_cache_bytes': listed,
                    'listed_cache_entries': total, 'repository_cache_bytes': max(aggregate, listed),
                    'visible_blob_count': len(visible), '_visible_blob_sizes': visible}
        if not rows or len(identities) > total:
            raise ValueError('incomplete cache listing')
    raise ValueError('cache listing page limit exceeded')


def allocation(used):
    if type(used) is not int or not 0 <= used <= LIMIT:
        raise ValueError('unknown repository cache usage')
    return max(0, (LIMIT - RESERVE - used) // EXPORTERS)


def preview_inventory(root, visible):
    """Discount only verified OCI layer blobs already readable on this ref."""
    files = list(root.rglob('*'))
    if root.is_symlink() or any(p.is_symlink() for p in files):
        raise ValueError('cache preview symlink')
    regular = [p for p in files if p.is_file()]
    if any(not stat.S_ISREG(p.stat().st_mode) or p.stat().st_nlink != 1 for p in regular):
        raise ValueError('cache preview file custody')
    total = sum(p.stat().st_size for p in regular)

    def read_json(path):
        if path.stat().st_size > 1024 ** 2:
            raise ValueError('oversized cache metadata')
        return json.loads(path.read_bytes())

    def blob(descriptor):
        raw_digest = descriptor['digest']
        match = SHA256.fullmatch(raw_digest) if isinstance(raw_digest, str) else None
        size = descriptor['size']
        if not match or type(size) is not int or size < 0:
            raise ValueError('unknown cache descriptor')
        path = root / 'blobs' / 'sha256' / match[1]
        if not path.is_file() or path.stat().st_size != size:
            raise ValueError('cache descriptor size mismatch')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 ** 2), b''):
                digest.update(chunk)
        if digest.hexdigest() != match[1]:
            raise ValueError('cache descriptor digest mismatch')
        return path, match[1], size

    index = read_json(root / 'index.json')
    if (index.get('schemaVersion') != 2 or index.get('mediaType') != 'application/vnd.oci.image.index.v1+json'
            or len(index['manifests']) != 1
            or index['manifests'][0].get('mediaType') != 'application/vnd.oci.image.manifest.v1+json'):
        raise ValueError('unknown cache index')
    manifest = read_json(blob(index['manifests'][0])[0])
    if (manifest.get('schemaVersion') != 2 or manifest.get('mediaType') != 'application/vnd.oci.image.manifest.v1+json'
            or manifest['config']['mediaType'] != 'application/vnd.buildkit.cacheconfig.v0'):
        raise ValueError('unknown cache manifest')
    read_json(blob(manifest['config'])[0])
    layers = manifest['layers']
    if not isinstance(layers, list) or len(layers) > 1000:
        raise ValueError('unknown cache layers')
    seen, already = set(), 0
    for layer in layers:
        if layer['mediaType'] not in ('application/vnd.oci.image.layer.v1.tar+gzip',
                                      'application/vnd.docker.image.rootfs.diff.tar.gzip'):
            raise ValueError('unknown cache layer compression')
        _, digest, size = blob(layer)
        if digest in seen:
            raise ValueError('duplicate cache layer descriptor')
        seen.add(digest)
        if digest in visible:
            if visible[digest] != size:
                raise ValueError('existing blob size mismatch')
            already += size
    return total, already


def decide(used, cache_bytes, allowance, already=0):
    allocation(used)
    if type(allowance) is not int or not 0 <= allowance <= (LIMIT - RESERVE) // EXPORTERS:
        raise ValueError('unknown architecture allowance')
    if type(cache_bytes) is not int or cache_bytes <= 0:
        raise ValueError('empty builder cache inventory')
    if type(already) is not int or not 0 <= already <= cache_bytes:
        raise ValueError('unknown existing blob bytes')
    # Both backends use the default gzip/mode=max settings. Count every OCI
    # file plus a metadata margin. The immutable allowance was obtained before
    # this run's exporters began, so a completed sibling is not counted twice.
    upper = cache_bytes - already + 64 * 1024 ** 2
    return {'repository_cache_bytes': used, 'local_cache_bytes': cache_bytes,
            'export_upper_bound_bytes': upper, 'limit_bytes': LIMIT,
            'reserve_bytes': RESERVE, 'concurrent_exporters': EXPORTERS,
            'architecture_allowance_bytes': allowance,
            'verified_existing_blob_bytes': already, 'incremental_cache_bytes': cache_bytes - already,
            'export_allowed': upper <= allowance and used + upper <= LIMIT - RESERVE}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--preview', type=Path)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--allocation', type=int, default=0)
    args = parser.parse_args()
    report = {'export_allowed': False}
    try:
        repo = os.environ['GITHUB_REPOSITORY']
        if len(repo.split('/')) != 2 or any(c not in
                'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./' for c in repo):
            raise ValueError('invalid repository')
        def fetch(suffix):
            request = urllib.request.Request(
                'https://api.github.com/repos/' + repo + suffix,
                headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                         'Accept': 'application/vnd.github+json',
                         'X-GitHub-Api-Version': '2022-11-28'})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        usage = observed_usage(fetch, os.environ.get('GITHUB_REF'))
        visible = usage.pop('_visible_blob_sizes')
        used = usage['repository_cache_bytes']
        if args.prepare:
            report = {'repository_cache_bytes': used, 'architecture_allowance_bytes': allocation(used)}
        else:
            total, already = preview_inventory(args.preview, visible)
            report = decide(used, total, args.allocation, already)
        report.update(usage)
    except Exception:
        # Do not print HTTP bodies, authentication headers or runner state.
        report['reason'] = 'usage_or_inventory_unavailable'
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('allowed=' + str(report.get('export_allowed', False)).lower() + '\n')
        output.write('bytes=' + str(report.get('architecture_allowance_bytes', 0)) + '\n')
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
