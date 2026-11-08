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


def allocation(used):
    if type(used) is not int or not 0 <= used <= LIMIT:
        raise ValueError('unknown repository cache usage')
    return max(0, (LIMIT - RESERVE - used) // EXPORTERS)


def decide(used, cache_bytes, allowance):
    allocation(used)
    if type(allowance) is not int or not 0 <= allowance <= (LIMIT - RESERVE) // EXPORTERS:
        raise ValueError('unknown architecture allowance')
    if type(cache_bytes) is not int or cache_bytes <= 0:
        raise ValueError('empty builder cache inventory')
    # Both backends use the default gzip/mode=max settings. Count every OCI
    # file plus a metadata margin. The immutable allowance was obtained before
    # this run's exporters began, so a completed sibling is not counted twice.
    upper = cache_bytes + 64 * 1024 ** 2
    return {'repository_cache_bytes': used, 'local_cache_bytes': cache_bytes,
            'export_upper_bound_bytes': upper, 'limit_bytes': LIMIT,
            'reserve_bytes': RESERVE, 'concurrent_exporters': EXPORTERS,
            'architecture_allowance_bytes': allowance,
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
        request = urllib.request.Request(
            'https://api.github.com/repos/' + repo + '/actions/cache/usage',
            headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                     'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(request, timeout=20) as response:
            usage = json.load(response)
        used = usage['active_caches_size_in_bytes']
        if args.prepare:
            report = {'repository_cache_bytes': used, 'architecture_allowance_bytes': allocation(used)}
        else:
            files = list(args.preview.rglob('*'))
            if not (args.preview / 'index.json').is_file() or any(p.is_symlink() for p in files):
                raise ValueError('invalid local cache preview')
            report = decide(used, sum(p.stat().st_size for p in files if p.is_file()), args.allocation)
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
