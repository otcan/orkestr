"""Exercise the real Dockerfile's fail-fast gate and cross-source tooling cache.

Does not compile application code or claim compilation-cache reuse. Run with an
empty Docker config in CI, just like the anonymous public-source image build.
"""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def build(source, target, log, jobs='2'):
    start = time.monotonic()
    with log.open('w') as stream:
        result = subprocess.run(
            ['docker', 'buildx', 'build', '--progress=rawjson', '--target', target,
             '--build-arg', 'SOURCE_COMMIT=' + source, '--build-arg', 'BUILD_JOBS=' + jobs,
             '--file', str(HERE / 'Dockerfile'), str(ROOT)],
            text=True, stdout=stream, stderr=subprocess.STDOUT, timeout=1200)
    raw = log.read_text()
    events = []
    for line in raw.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return result.returncode, events, time.monotonic() - start, raw


def setup_events(events):
    # Raw BuildKit progress updates repeat a vertex; keep its final state.
    vertices = {}
    for update in events:
        for event in update.get('vertexes', [update]):
            key = event.get('digest', event.get('id'))
            if key and 'name' in event:
                vertices[key] = {**vertices.get(key, {}), **event}
    return [v for v in vertices.values() if 'RUN ' in v['name'] and
            any(command in v['name'] for command in ('apt-get', 'rustup target', 'ln -s'))]


def refusal_seconds(events, message='SOURCE_COMMIT must be the exact 40-character public commit'):
    logs, failures = [], []
    for update in events:
        for item in update.get('logs', [update] if 'data' in update else []):
            logs.append(base64.b64decode(item['data']).decode(errors='replace'))
        for event in update.get('vertexes', [update]):
            if '[source-check ' in event.get('name', '') and event.get('error'):
                failures.append(event)
    if len(failures) != 1 or message not in ''.join(logs):
        raise RuntimeError('missing actual source-validation failure evidence')
    failure = failures[0]
    return (datetime.datetime.fromisoformat(failure['completed']) -
            datetime.datetime.fromisoformat(failure['started'])).total_seconds()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--other-source', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.source == args.other_source:
        parser.error('two different source commits are required')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {'dockerfile_sha256': hashlib.sha256((HERE / 'Dockerfile').read_bytes()).hexdigest(),
              'sources': [args.source, args.other_source], 'checks': []}
    for index, invalid in enumerate(('', 'a' * 39, 'A' * 40)):
        code, events, seconds, raw = build(
            invalid, 'runtime', args.report.with_suffix('.invalid-' + str(index) + '.log'))
        if code == 0 or 'SOURCE_COMMIT must be the exact 40-character public commit' not in raw:
            raise RuntimeError('invalid source was not explicitly refused')
        if any(v.get('started') for v in setup_events(events)):
            raise RuntimeError('invalid source started an expensive setup command')
        report['checks'].append({'invalid_length': len(invalid), 'refused_before_setup': True,
                                 'seconds': seconds, 'validation_seconds': refusal_seconds(events)})
    for index, jobs in enumerate(('', '0', '-1', '1.5', '65')):
        code, events, seconds, _ = build(
            args.source, 'runtime', args.report.with_suffix('.invalid-jobs-' + str(index) + '.log'), jobs)
        if code == 0 or any(v.get('started') for v in setup_events(events)):
            raise RuntimeError('invalid job limit accepted or started setup')
        report['checks'].append({'invalid_jobs': jobs, 'refused_before_setup': True, 'seconds': seconds,
                                 'validation_seconds': refusal_seconds(events, 'BUILD_JOBS must be a whole number from 1 to 64.')})
    for jobs in ('1', '8', '12', '64'):
        code, _, seconds, _ = build(
            args.source, 'source-check', args.report.with_suffix('.valid-jobs-' + jobs + '.log'), jobs)
        if code:
            raise RuntimeError('valid job limit refused')
        report['checks'].append({'valid_jobs': jobs, 'accepted_by_gate': True, 'seconds': seconds})
    for index, source in enumerate(report['sources']):
        code, events, seconds, _ = build(
            source, 'tooling', args.report.with_suffix('.tooling-' + str(index) + '.log'))
        setup = setup_events(events)
        if code or len(setup) != 3:
            raise RuntimeError('tooling build failed or expected setup vertices are missing')
        if index and not all(v.get('cached') for v in setup):
            raise RuntimeError('changing source commit invalidated tooling')
        report['checks'].append({'source': source, 'seconds': seconds,
                                 'setup_cached': [bool(v.get('cached')) for v in setup]})
    report['scope'] = 'format validation and tooling cache only; no application compilation claim'
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
