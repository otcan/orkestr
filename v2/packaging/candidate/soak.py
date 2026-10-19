#!/usr/bin/env python3
"""Bounded read-only health samples; never starts servers or opens/migrates a DB."""
import argparse
from datetime import datetime, timezone
import json
import math
import time
from urllib.parse import urlsplit
import urllib.request


def measure(origin, samples, interval, timeout, max_latency_ms=None):
    parsed = urlsplit(origin)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise RuntimeError('explicit loopback origin required')
    if not 1 <= samples <= 10000 or not 0 <= interval <= 60 or not 0 < timeout <= 10:
        raise RuntimeError('bounded sample/interval/timeout required')
    if max_latency_ms is not None and (not math.isfinite(max_latency_ms) or max_latency_ms <= 0):
        raise RuntimeError('positive finite latency threshold required')
    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    rows = []
    for index in range(samples):
        start = time.monotonic()
        row = {'sample': index, 'offset_ms': round((start-started)*1000,3), 'observed_at': datetime.now(timezone.utc).isoformat(), 'elapsed_ms': None, 'ok': False}
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
    failures = longest = recoveries = 0
    for row in rows:
        if row['ok']:
            recoveries += bool(failures)
            failures = 0
        else:
            failures += 1
            longest = max(longest, failures)
    return {'started_at': started_at, 'duration_ms': round((time.monotonic()-started)*1000,3),
            'coverage': {'health': 'observed', 'latency': 'observed', 'crash': 'unexecuted',
                         'restart': 'unexecuted', 'revocation': 'unexecuted'},
            'longest_consecutive_failures': longest, 'health_recovery_transitions': recoveries,
            'max_latency_ms': max_latency_ms,
            'latency_threshold_passed': None if max_latency_ms is None else all(r['ok'] and r['elapsed_ms'] <= max_latency_ms for r in rows),
            'scope': 'HTTP health latency only; no browser/provider/load or schema-compatibility claim',
            'samples': rows, 'successes': sum(r['ok'] for r in rows),
            'latency_ms': {'p50': times[math.ceil(len(times)*.50)-1], 'p95': times[math.ceil(len(times)*.95)-1], 'max': times[-1]}}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--origin', required=True)
    p.add_argument('--samples', type=int, required=True)
    p.add_argument('--interval', type=float, default=1)
    p.add_argument('--timeout', type=float, default=2)
    p.add_argument('--output', required=True)
    p.add_argument('--max-latency-ms', type=float)
    a = p.parse_args()
    with open(a.output, 'x') as stream:
        value = measure(a.origin,a.samples,a.interval,a.timeout,a.max_latency_ms)
        json.dump(value, stream, sort_keys=True, indent=2); stream.write('\n')
    raise SystemExit(0 if value['successes'] == a.samples and value['latency_threshold_passed'] is not False else 1)
