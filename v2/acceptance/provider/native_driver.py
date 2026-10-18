#!/usr/bin/env python3
"""Shared process ownership for explicitly authorized native acceptance."""
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

from prepare_http import Candidate, NoRedirect
from verify_package import Refused, require, verify


def protected_cleanup(operation):
    """Defer termination only while a bounded owned-child cleanup is running."""
    numbers = (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, numbers)
    previous = {number: signal.getsignal(number) for number in numbers}
    deferred = set()
    remaining = signal.alarm(0)
    started = time.monotonic()
    try:
        for number in numbers:
            signal.signal(number, lambda number, _frame: deferred.add(number))
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        result = operation()
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, numbers)
        elapsed = time.monotonic() - started
        for number, handler in previous.items():
            signal.signal(number, handler)
        if remaining:
            if elapsed >= remaining:
                deferred.add(signal.SIGALRM)
            else:
                signal.alarm(max(1, int(remaining - elapsed)))
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    return result, bool(deferred)


def private_json(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600,
            'private_input_invalid')
    require(info.st_size <= 32768, 'private_input_too_large')
    return json.loads(path.read_text())


def process(pid):
    try:
        path = Path('/proc') / str(pid)
        fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'state': fields[0], 'ppid': int(fields[1]),
                'start': int(fields[19]), 'uid': path.stat().st_uid}
    except (OSError, ValueError, IndexError):
        return None


def alive(item):
    now = process(item['pid'])
    return bool(now and now['start'] == item['start'] and now['uid'] == item['uid']
                and now['state'] not in ('Z', 'X'))


def exists(item):
    now = process(item['pid'])
    return bool(now and now['start'] == item['start'] and now['uid'] == item['uid'])


def descendants(pid):
    entries = [process(int(p.name)) for p in Path('/proc').iterdir() if p.name.isdigit()]
    entries = [p for p in entries if p and p['uid'] == os.geteuid()]
    selected = {pid}
    for _ in range(20):
        added = {p['pid'] for p in entries if p['ppid'] in selected}
        if added <= selected:
            break
        selected |= added
    return [p for p in entries if p['pid'] in selected]


class ActiveCandidate(Candidate):
    def __init__(self, server, root, session):
        super().__init__(server, root)
        self.bootstrap = session['bootstrap']
        self.session = session
        self.known = {}
        self.native_seen = set()
        self.native_path = None
        self.forced_cleanup = False

    def observe(self):
        if self.child is None:
            return
        for item in descendants(self.child.pid):
            self.known[(item['pid'], item['start'])] = item
            try:
                if os.readlink(f"/proc/{item['pid']}/exe") == self.native_path:
                    self.native_seen.add((item['pid'], item['start']))
            except OSError:
                pass

    def start_active(self):
        require(self.child is None, 'candidate_already_started')
        self.child = subprocess.Popen([self.server], cwd=self.root, env={
            'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
            'ORKESTR_V2_HOME': str(self.root / 'data'),
            'ORKESTR_V2_BIND': f'127.0.0.1:{self.port}',
            'ORKESTR_V2_ORIGIN': self.origin,
            'ORKESTR_V2_BOOTSTRAP_TOKEN': self.bootstrap,
            'ORKESTR_V2_EXECUTION_CONFIG': str(self.root / 'execution.json'),
        }, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=True, start_new_session=True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            self.observe()
            require(self.child.poll() is None, 'active_server_start_failed')
            try:
                code, body, _ = self.request('/api/v2/health')
                if code == 200:
                    require(body.get('product') == 'orkestr-v2' and body.get('fixture_mode') is False,
                            'ordinary_server_required')
                    return
            except OSError:
                pass
            time.sleep(.05)
        raise Refused('active_server_readiness_timeout')

    def browser(self, path, *, method='GET', body=None):
        return self.request(path, method=method, body=body, headers={
            'Origin': self.origin, 'Cookie': self.session['cookie'],
            'x-orkestr-csrf': self.session['csrf']})

    def close_owned(self):
        self.observe()
        if self.child is not None:
            if self.child.poll() is None:
                self.child.send_signal(signal.SIGINT)
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.forced_cleanup = True
                    self.child.kill()
                    self.child.wait(timeout=3)
            self.child = None
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and any(exists(p) for p in self.known.values()):
            time.sleep(.05)
        remaining = [p for p in self.known.values() if alive(p)]
        if remaining:
            self.forced_cleanup = True
            for item in remaining:
                if alive(item):
                    try:
                        os.kill(item['pid'], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            time.sleep(.2)
        return not any(exists(p) for p in self.known.values())


def completion_payload(candidate, path, run_id, completion_id):
    request = urllib.request.Request(candidate.origin + path + '/events', headers={
        'Origin': candidate.origin, 'Cookie': candidate.session['cookie']})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    refs, total, completed = [], 0, False
    with opener.open(request, timeout=3) as stream:
        while total < 512 * 1024:
            line = stream.readline(32769)
            total += len(line)
            require(line and len(line) <= 32768, 'event_stream_invalid')
            if not line.startswith(b'data: '):
                continue
            event = json.loads(line[6:])
            payload = event.get('payload_ref_or_safe_payload', {})
            if payload.get('run_id') != run_id:
                continue
            observation = payload.get('observation', {})
            if observation.get('kind') == 'progress_ref':
                refs.append(observation['payload_id'])
            if event.get('event_id') == completion_id:
                require(observation.get('kind') == 'completed_proposal', 'completion_event_mismatch')
                completed = True
                break
    require(completed and refs, 'completion_output_missing')
    parts = []
    for ref in refs:
        uuid.UUID(ref)
        code, payload, headers = candidate.browser(path + '/payloads/' + ref)
        require(code == 200 and headers.get('Cache-Control') == 'no-store'
                and isinstance(payload.get('text'), str), 'payload_read_failed')
        parts.append(payload['text'])
    return ''.join(parts), len(refs)

