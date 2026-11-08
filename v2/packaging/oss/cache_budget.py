"""Conservative, read-only admission for two native GHA cache exporters.

Never deletes caches or changes the repository's storage/billing settings.
Unknown usage disables export while the ordinary image checks still run.
"""
import argparse
import json
import os
from pathlib import Path
import urllib.request

LIMIT = 10 * 1024 ** 3
RESERVE = 1024 ** 3
EXPORTERS = 2


def decide(used, cache_bytes):
    if type(used) is not int or not 0 <= used <= LIMIT:
        raise ValueError('unknown repository cache usage')
    if type(cache_bytes) is not int or cache_bytes <= 0:
        raise ValueError('empty builder cache inventory')
    # The local preview uses the same gzip/force-compression/mode=max settings
    # as GHA. Count every OCI file plus a conservative metadata margin.
    # Each architecture reserves half the remaining space, even if the other
    # exporter has not yet appeared in GitHub's usage response.
    upper = cache_bytes + 64 * 1024 ** 2
    return {'repository_cache_bytes': used, 'local_cache_bytes': cache_bytes,
            'export_upper_bound_bytes': upper, 'limit_bytes': LIMIT,
            'reserve_bytes': RESERVE, 'concurrent_exporters': EXPORTERS,
            'export_allowed': used + EXPORTERS * upper <= LIMIT - RESERVE}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--preview', type=Path, required=True)
    args = parser.parse_args()
    report = {'export_allowed': False}
    try:
        repo = os.environ['GITHUB_REPOSITORY']
        if len(repo.split('/')) != 2 or any(c not in
                'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./' for c in repo):
            raise ValueError('invalid repository')
        request = urllib.request.Request(
            'https://api.github.com/repos/' + repo + '/actions/cache/usage',
            headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                     'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(request, timeout=20) as response:
            usage = json.load(response)
        files = list(args.preview.rglob('*'))
        if not (args.preview / 'index.json').is_file() or any(p.is_symlink() for p in files):
            raise ValueError('invalid local cache preview')
        report = decide(usage['active_caches_size_in_bytes'],
                        sum(p.stat().st_size for p in files if p.is_file()))
    except Exception:
        # Do not print HTTP bodies, authentication headers or runner state.
        report['reason'] = 'usage_or_inventory_unavailable'
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('allowed=' + str(report['export_allowed']).lower() + '\n')
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
