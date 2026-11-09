"""Sample only public build-resource counters; never argv, environment or HOME."""
import argparse
import datetime
import json
import os
from pathlib import Path
import time


def counters(proc=Path('/proc')):
    fields = (proc / 'stat').read_text().splitlines()[0].split()
    ticks = [int(value) for value in fields[1:9]]
    memory = {}
    for line in (proc / 'meminfo').read_text().splitlines():
        key, value, *_ = line.split()
        if key in ('MemTotal:', 'MemAvailable:'):
            memory[key[:-1]] = int(value) * 1024
    compilers = 0
    for entry in proc.iterdir():
        if entry.name.isdecimal():
            try:
                compilers += (entry / 'comm').read_text().strip() == 'rustc'
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                pass
    return sum(ticks), ticks[3] + ticks[4], memory, compilers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--stop', type=Path, required=True)
    args = parser.parse_args()
    with args.output.open('x', buffering=1) as output:
        def emit(row):
            output.write(json.dumps(row, sort_keys=True) + '\n')
        emit({'kind': 'metadata', 'cpus': os.cpu_count(),
              'memory_scope': 'runner MemTotal minus MemAvailable, not process RSS',
              'sample_interval_seconds': 2})
        try:
            previous = counters()
            while not args.stop.exists():
                time.sleep(2)
                current = counters()
                total, idle = current[0] - previous[0], current[1] - previous[1]
                emit({'kind': 'sample', 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'monotonic_seconds': time.monotonic(),
                      'cpu_busy_percent': 100 * (total - idle) / total if total > 0 else None,
                      'memory_bytes': current[2], 'visible_rustc': current[3]})
                previous = current
            emit({'kind': 'complete'})
        except Exception as error:
            emit({'kind': 'error', 'type': type(error).__name__})


if __name__ == '__main__':
    main()
