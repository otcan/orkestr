#!/usr/bin/env python3
"""Bounded read-only health samples; never starts servers or opens/migrates a DB."""
import argparse
import json
import math
import time
from urllib.parse import urlsplit
import urllib.request


def measure(origin, samples, interval, timeout):
    parsed = urlsplit(origin)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise RuntimeError('explicit loopback origin required')
    if not 1 <= samples <= 10000 or not 0 <= interval <= 60 or not 0 < timeout <= 10:
        raise RuntimeError('bounded sample/interval/timeout required')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    rows = []
    for index in range(samples):
        start = time.monotonic()
        row = {'sample': index, 'elapsed_ms': None, 'ok': False}
        try:
            with opener.open(origin+'/api/v2/health', timeout=timeout) as response:
                body = json.load(response)
                row['ok'] = response.status == 200 and body.get('status') == 'ok' and body.get('product') == 'orkestr-v2' and body.get('fixture_mode') is False
        except Exception as error:
            row['error_type'] = type(error).__name__  # Never record headers, credentials or body.
        row['elapsed_ms'] = round((time.monotonic()-start)*1000, 3)
        rows.append(row)
        if index+1 < samples:
            time.sleep(interval)
    times = sorted(r['elapsed_ms'] for r in rows)
    return {'scope': 'HTTP health latency only; no browser/provider/load or schema-compatibility claim',
            'samples': rows, 'successes': sum(r['ok'] for r in rows),
            'latency_ms': {'p50': times[math.ceil(len(times)*.50)-1], 'p95': times[math.ceil(len(times)*.95)-1], 'max': times[-1]}}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--origin', required=True)
    p.add_argument('--samples', type=int, required=True)
    p.add_argument('--interval', type=float, default=1)
    p.add_argument('--timeout', type=float, default=2)
    p.add_argument('--output', required=True)
    a = p.parse_args()
    value = measure(a.origin,a.samples,a.interval,a.timeout)
    with open(a.output, 'x') as stream:
        json.dump(value, stream, sort_keys=True, indent=2); stream.write('\n')
    raise SystemExit(0 if value['successes'] == a.samples else 1)
