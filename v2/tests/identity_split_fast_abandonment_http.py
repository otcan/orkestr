"""Abandoned Fast must not revoke a real split-UID Root window's Deep.

All state is disposable. A cancelled historical Fast row makes the first input
ineligible for Fast without fabricating success, readiness, or a reap witness.
The actual Rust lineage owns a ReadyFast while Deep's unchanged 15-second
first-presentation wait expires. A late input must not kill Deep through the
real Root launcher's proxy/lifecycle accounting. No real provider or account.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from identity_split_host_fast_http import FastHostRehearsal
from identity_split_service_http import GID, Rehearsal, wait
from codex_bounded.trust import exists, process


class AbandonedFastRehearsal(FastHostRehearsal):
    # FastHostRehearsal.request waits for both roles to succeed. This case
    # intentionally has no new Fast inference, so use the base HTTP transport.
    request = Rehearsal.request

    def start_rehearsal(self):
        super().start_rehearsal()
        original = self.manager.dispatch
        def dispatch(request, *args, **kwargs):
            # Core's opening transaction already committed before this real
            # manager call. Seed before any native launches, never under a
            # Core metadata writer or by bypassing window source admission.
            if request['operation'] == 'admit' and not hasattr(self, 'historical_fast'):
                self.cancelled_fast_history(dict(message_id=request['input_message_id'],
                                                event_id=request['input_event_id']))
            return original(request, *args, **kwargs)
        self.manager.dispatch = dispatch

    def cancelled_fast_history(self, receipt):
        """Seed only a cancelled, foreign-context historical attempt.

        FK/check/unique constraints stay enabled. The retired session cannot
        become the current canonical Fast binding and no acceptance is added.
        This is the exact durable dedup precondition, not a simulated worker.
        """
        ids = {key: str(uuid.uuid4()) for key in ('context', 'session', 'run', 'incarnation')}
        with sqlite3.connect(self.package.data / 'core.sqlite3') as db:
            db.execute('PRAGMA foreign_keys=ON')
            sequence = db.execute('SELECT sequence FROM events WHERE id=? AND message_id=?',
                                  (receipt['event_id'], receipt['message_id'])).fetchone()[0]
            db.execute('INSERT INTO production_supervisors '
                       '(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,'
                       'generation,lease_deadline_ms) VALUES (?,?,?,?,?,?,1,1)',
                       (ids['context'], self.owner, 'codex', 'synthetic-retired-fast',
                        'synthetic-retired-fast', ids['incarnation']))
            db.execute('INSERT INTO session_bindings '
                       '(id,owner_id,conversation_id,role,provider_kind,provider_namespace,'
                       'native_session_id,generation,state) VALUES (?,?,?,?,?,?,?,1,?)',
                       (ids['session'], self.owner, self.conversation, 'fast', 'codex',
                        'synthetic-retired-fast', 'synthetic-cancelled-fast', 'retired'))
            db.execute('INSERT INTO production_runs '
                       '(id,context_id,incarnation_id,owner_id,conversation_id,session_id,'
                       'native_session_id,provider_kind,binding_generation,message_id,event_id,'
                       'scope_sequence,claim_generation,request_key,input_digest,lease_generation,'
                       'dispatch_fence,lease_deadline_ms,attempt,state,dispatch_state,role) '
                       'VALUES (?,?,?,?,?,?,?,?,1,?,?,?,0,?,?,1,1,1,1,?,?,?)',
                       (ids['run'], ids['context'], ids['incarnation'], self.owner,
                        self.conversation, ids['session'], 'synthetic-cancelled-fast', 'codex',
                        receipt['message_id'], receipt['event_id'], sequence,
                        'synthetic-cancelled-fast', '0' * 64, 'cancelled', 'quarantined', 'fast'))
            assert not db.execute('PRAGMA foreign_key_check').fetchall()
        self.historical_fast = ids

    def role_events(self, role):
        home = self.fixture.account if role == 'deep' else self.fast_home
        path = home / 'sessions/synthetic-role.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def deep_alive(self, original, launch):
        assert not self.pump_errors, self.pump_errors
        assert exists(original), 'original Deep native was killed by Fast cleanup'
        assert exists({'pid': launch['proxy_pid'], 'start': launch['proxy_start'],
                       'uid': self.package.authority_uid}), 'original Deep proxy was killed'
        current = next(row for row in self.claims() if
                       (row.get('broker_pid'), row.get('broker_start')) ==
                       (launch['broker_pid'], launch['broker_start']))
        assert current['state'] not in ('exited', 'quarantined'), current
        assert not self.manager.custody_fault, 'Root lost lifecycle custody'

    def run(self):
        self.initialize_core()
        self.start_rehearsal()
        (self.mapped / 'mode').write_text('hold')
        path = '/api/v2/conversations/' + self.conversation
        first_key = 'synthetic-abandoned-fast-first'
        code, first = self.request(path + '/messages', 'POST',
            dict(client_message_id=first_key, text='synthetic ordinary HTTP input 1', author='owner'))
        assert code == 202, (code, first)
        opened_at = time.monotonic()
        code, opened = self.request(path + '/window', 'POST', dict(
            request_key='window:' + first_key, input_message_id=first['message_id'],
            input_event_id=first['event_id'], input_request_key=first_key,
            expected_generation=0, window_id=None, predecessor_window_id=None))
        assert code == 201, (code, opened)

        def deep_started():
            assert not self.pump_errors, self.pump_errors
            return next((event for event in self.role_events('deep')
                         if event['kind'] == 'turn' and event['input_index'] == 1), None)
        deep_turn = wait(deep_started, 'Deep continued after real Fast first-presentation timeout', seconds=35)
        elapsed = time.monotonic() - opened_at
        assert elapsed >= 14, ('first-presentation timeout was bypassed', elapsed)
        assert any(event['kind'] == 'ready' for event in self.role_events('fast'))
        assert not any(event['kind'] == 'turn' for event in self.role_events('fast'))
        original = process(deep_turn['pid'])
        assert original['start'] == deep_turn['process_start']
        deep_launch = next(row for row in self.claims() if row['role'] == 'deep')
        self.deep_alive(original, deep_launch)

        # This is a genuine second owner input through Core, not a fake
        # companion wake or direct cleanup call. It exposes the old path:
        # fast_input returns a new source, claim_start(false) drops ReadyFast.
        key = 'synthetic-abandoned-fast-late'
        code, second = self.request(path + '/messages', 'POST', dict(
            client_message_id=key, text='synthetic ordinary HTTP input 2', author='owner'))
        assert code == 202, (code, second)
        code, current = self.request(path + '/window')
        assert code == 200 and current['state'] == 'active', (code, current)
        code, joined = self.request(path + '/window', 'POST', dict(
            request_key='window:' + key, input_message_id=second['message_id'],
            input_event_id=second['event_id'], input_request_key=key,
            expected_generation=current['generation'], window_id=current['window_id'],
            predecessor_window_id=None))
        assert code == 201, (code, joined)

        # Keep the actual original Deep held long enough for real Root polling
        # to observe the abandoned Fast proxy. A future-only assertion could
        # otherwise miss the destructive EOF cascade.
        until = time.monotonic() + 5
        while time.monotonic() < until:
            self.deep_alive(original, deep_launch)
            time.sleep(.02)
        fast_launches = [row for row in self.claims() if row['role'] == 'fast']
        assert fast_launches and all(row['state'] == 'exited' for row in fast_launches), fast_launches
        assert not any(event['kind'] == 'turn' for event in self.role_events('fast'))
        assert self.rows("SELECT id FROM production_runs WHERE role='fast'") == [
            {'id': self.historical_fast['run']}]

        for number in (1, 2):
            (self.mapped / ('release-' + str(number))).touch(mode=0o600)
        def accepted():
            assert not self.pump_errors, self.pump_errors
            rows = self.rows("SELECT id,state,message_id FROM production_runs WHERE role='deep'")
            return rows if {row['message_id'] for row in rows} == {
                first['message_id'], second['message_id']} and all(
                    row['state'] == 'succeeded' for row in rows) else None
        completed = wait(accepted, 'both original inputs canonically accepted by Deep', seconds=30)
        drain = self.package.data / 'deploy-drain.request'
        drain.touch(mode=0o600); os.chown(drain, self.package.authority_uid, GID)
        def closed():
            code, value = self.request(path + '/window')
            return code == 200 and value['state'] == 'closed' and all(
                row['state'] == 'exited' for row in self.claims())
        wait(closed, 'real Root window and original children cleanly retired', seconds=20)
        return dict(actual_root_proxy_lifecycle=True, split_uid=True,
            historical_fast_cancelled_only=True, fast_inference_turns=0,
            deep_original_survived_fast_retirement=True, deep_runs=completed,
            first_presentation_elapsed_seconds=elapsed, additional_inputs=1,
            server_identity=self.server_identity, server_sha256=self.server_sha256,
            fixture_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            actual_provider=False, live_activation=False,
            production_startup_gate_bypassed_only_in_test=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    pin = parser.add_mutually_exclusive_group(required=True)
    pin.add_argument('--expected-source')
    pin.add_argument('--expected-binary-sha256')
    parser.add_argument('--report', required=True)
    args = parser.parse_args(); assert os.geteuid() == 0
    identity = json.loads(subprocess.check_output([args.binary, '--version', '--json']))
    if args.expected_source:
        assert identity.get('source_commit') == args.expected_source, identity
    else:
        assert hashlib.sha256(Path(args.binary).read_bytes()).hexdigest() == args.expected_binary_sha256
    os.umask(0o077)
    case = AbandonedFastRehearsal(args.binary)
    report = dict(passed=False, actual_provider=False, live_activation=False)
    try:
        report.update(case.run(), passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__, error=str(error),
            manager_errors=case.pump_errors, launch_claims=case.claims(),
            deep_events=case.role_events('deep'), fast_events=case.role_events('fast'),
            runs=case.rows('SELECT id,role,state,message_id FROM production_runs'))
        if case.process and case.process.stderr:
            os.set_blocking(case.process.stderr.fileno(), False)
            try: report['synthetic_core_stderr'] = os.read(case.process.stderr.fileno(), 16384).decode(errors='replace')
            except BlockingIOError: pass
        raise
    finally:
        try:
            case.close(); report['cleanup_completed'] = True
        finally:
            output = Path(args.report)
            output.write_text(json.dumps(report, indent=2) + '\n'); output.chmod(0o600)
    print(json.dumps(dict(passed=True, actual_provider=False, original_deep_survived=True)))


if __name__ == '__main__': main()
