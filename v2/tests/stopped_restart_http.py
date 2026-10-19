"""Configured stopped-only restart using owned synthetic peers and ordinary APIs.

Usage: stopped_restart_http.py ABSOLUTE_SERVER [codex|claude|ack-only|foreign|killed-expired]
Never writes SQLite authority, controls a reported PID, or launches a real provider.
"""
import json
import signal
import sys
import time

import owned_execution_http as ordinary
from owned_execution_recovery import RecoveryCase, stop_intent, assert_held, counts, accept
from owned_claude_stop_http import StopCase


def clean_shutdown(case):
    process = case.process
    assert process is not None and process.poll() is None
    case.trace()  # retain independently observed host process identities
    started = time.monotonic()
    process.send_signal(signal.SIGTERM)
    _, stderr = process.communicate(timeout=5)
    case.process = None
    print(json.dumps({'event': 'shutdown', 'code': process.returncode,
                      'elapsed_seconds': time.monotonic() - started,
                      'stderr': stderr}), flush=True)
    assert process.returncode == 0
    ordinary.wait_for(case.peer_gone, 'every original native process must disappear')


def provenance(case, expected):
    rows = case.rows('SELECT count(*) FROM production_stopped_retirements')
    print(json.dumps({'event': 'stopped_retirement_rows', 'rows': rows}), flush=True)
    assert rows == [(expected,)], 'original reap proof must reach durable stopped retirement'


def refuse_restart(case):
    # Start only the exact configured binary. No synthetic DB mutation or expiry
    # override can manufacture retirement provenance.
    import subprocess
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'ORKESTR_V2_HOME': str(case.home),
           'ORKESTR_V2_BIND': f'127.0.0.1:{case.port}', 'ORKESTR_V2_ORIGIN': case.origin,
           'ORKESTR_V2_EXECUTION_CONFIG': str(case.root / 'execution.json')}
    result = subprocess.run([str(ordinary.binary)], env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, timeout=6)
    print(json.dumps({'event': 'refused_restart', 'code': result.returncode,
                      'stderr': result.stderr}), flush=True)
    assert result.returncode != 0


def stopped_codex():
    case = RecoveryCase()
    try:
        case.setup(); case.configure_mode('stop')
        first, old, intent, receipt = stop_intent(case)
        ordinary.wait_for(lambda: case.phase('cancelled'), 'genuine Codex Stopped')
        ordinary.wait_for(case.peer_gone, 'original Codex tree reap')
        held = assert_held(case, old, first['run_id'])
        prior = case.rows('SELECT id,incarnation_id,session_id,native_session_id FROM production_runs')
        assert len(prior) == 1
        clean_shutdown(case)
        provenance(case, 1)
        case.start(configured=True)
        # Setup is reserved by Core, but fresh inference cannot be inferred from
        # held input, a stopped projection, restart, or process disappearance.
        time.sleep(.2)
        counts(case, 1, [1])
        assert case.request(case.path + '/stop', 'POST', intent)[:2] == (200, receipt)
        assert assert_held(case, old, first['run_id']) == held
        assert case.message(3)[0] == 202
        second = ordinary.wait_for(lambda: case.phase('awaiting_acceptance'), 'fresh restarted Codex input')
        counts(case, 2, [1, 3])
        rows = case.rows('SELECT id,incarnation_id,session_id,native_session_id FROM production_runs ORDER BY scope_sequence')
        assert rows[0] == prior[0] and rows[1][1] != rows[0][1] and rows[1][2:] == rows[0][2:]
        assert assert_held(case, old, first['run_id']) == held
        accept(case, second, 'stopped-restart-accept')
        clean_shutdown(case)
        print(json.dumps({'event': 'codex_positive', 'native_preserved': True, 'held_preserved': True}), flush=True)
    finally:
        case.cleanup()


def claude_case(mode):
    case = StopCase()
    case.setup(); case.stop(); case.configure(mode); case.start(configured=True)
    ordinary.wait_for(case.native_ready, 'Claude requested identity reservation')
    assert case.message()[0] == 202
    first = case.live(1)
    first = ordinary.wait_for(lambda: (s if (s := case.phase('running')) and s['capabilities']['stop'] else None), 'Claude Stop available')
    assert case.message(2)[0] == 202
    intent = {'run_id': first['run_id'], 'expected_revision': first['revision'],
              'expected_control_revision': first['control_revision'], 'request_key': 'stopped-restart'}
    code, receipt, _ = case.request(case.path + '/stop', 'POST', intent)
    assert code == 200
    ordinary.wait_for(lambda: any(r['kind'] == 'interrupt-ack' for r in case.trace()), 'Claude interrupt ACK')
    return case, first, intent, receipt


def stopped_claude():
    case, first, intent, receipt = claude_case('success')
    try:
        case.release('terminal', 1)
        ordinary.wait_for(lambda: case.phase('cancelled'), 'Claude ACK plus genuine aborted terminal and reap')
        assert case.old_gone(1)
        held = case.held()['held']
        assert len(held) == 1
        prior = case.rows('SELECT id,incarnation_id,session_id,native_session_id FROM production_runs')
        clean_shutdown(case)
        provenance(case, 1)
        case.start(configured=True)
        time.sleep(.2)
        assert len([r for r in case.trace() if r['kind'] == 'spawn']) == 1
        assert case.held()['held'] == held
        assert case.request(case.path + '/stop', 'POST', intent)[:2] == (200, receipt)
        assert case.message(3)[0] == 202
        second = case.live(2)
        assert second['run_id'] != first['run_id'] and case.old_gone(1)
        assert case.begun(2)['resumed'] and case.begun(2)['native'] == case.begun(1)['native']
        assert case.begun(2)['input_uuid'] != held[0]['message_id']
        rows = case.rows('SELECT id,incarnation_id,session_id,native_session_id FROM production_runs ORDER BY scope_sequence')
        assert rows[0] == prior[0] and rows[1][1] != rows[0][1] and rows[1][2:] == rows[0][2:]
        case.accept(case.propose(2), 2)
        ordinary.wait_for(case.peer_gone, 'accepted successor reap')
        assert case.held()['held'] == held
        clean_shutdown(case)
        print(json.dumps({'event': 'claude_positive', 'native_preserved': True, 'held_preserved': True}), flush=True)
    finally:
        case.cleanup()


def unconfirmed(mode):
    case, _, _, _ = claude_case(mode)
    try:
        if mode == 'foreign':
            case.release('terminal', 1)
        # Shutdown while ACK-only/foreign is unresolved must promptly clean up,
        # remain unknown, and issue no stopped retirement even after native EOF.
        clean_shutdown(case)
        assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'") == [(0,)]
        provenance(case, 0)
        refuse_restart(case)
        assert len([r for r in case.trace() if r['kind'] == 'turn']) == 1
    finally:
        case.cleanup()


def killed_expired():
    case, _, _, _ = claude_case('ack-only')
    try:
        process = case.process
        case.trace()
        process.kill()  # exact Popen-owned server, never an observed native PID
        _, stderr = process.communicate(timeout=5)
        case.process = None
        print(json.dumps({'event': 'forced_server_death', 'code': process.returncode, 'stderr': stderr}), flush=True)
        ordinary.wait_for(case.peer_gone, 'forced broker lifetime containment')
        # Prove even actual natural expiry cannot replace missing native terminal
        # and original typed graceful-retirement evidence.
        deadline = case.rows('SELECT lease_deadline_ms FROM production_supervisors')[0][0]
        while time.time() * 1000 <= deadline:
            time.sleep(min(.5, max(.001, (deadline - time.time() * 1000) / 1000)))
        provenance(case, 0)
        refuse_restart(case)
        assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'") == [(0,)]
        assert len([r for r in case.trace() if r['kind'] == 'turn']) == 1
    finally:
        case.cleanup()


if __name__ == '__main__':
    actions = {'codex': stopped_codex, 'claude': stopped_claude,
               'ack-only': lambda: unconfirmed('ack-only'),
               'foreign': lambda: unconfirmed('foreign'), 'killed-expired': killed_expired}
    for mode in sys.argv[2:] or actions:
        actions[mode]()
        print('stopped-only configured restart PASS:', mode, flush=True)
