"""Actual HTTP distinguishes correlated failure from unknown delivery."""
from pathlib import Path
import shutil
import owned_claude_http as claude
import owned_execution_http as ordinary


class FailureCase(claude.ClaudeCase):
    def configure(self, mode):
        super().configure(mode)
        shutil.copyfile(Path(__file__).with_name('owned_claude_failure_peer.py'),
                        self.root / 'synthetic-provider')


def exercise(mode):
    case = FailureCase()
    try:
        case.setup()
        case.stop()
        case.configure(mode)
        case.start(configured=True)
        ordinary.wait_for(case.native_ready, 'native initialization ACK')
        assert case.message()[0] == 202
        ordinary.wait_for(lambda: any(x['kind'] == 'turn' for x in case.trace()), 'consumed input')
        (case.workspace / 'release-error').touch()
        phase = 'failed' if mode == 'error' else 'blocked'
        status = ordinary.wait_for(lambda: case.phase(phase), 'bounded native error classification')
        assert status['progress'] is None and status.get('acceptance_candidate') is None
        assert status['capabilities'] == {'stop': False, 'steer': False}
        observations = case.rows('SELECT kind FROM production_observations ORDER BY run_sequence')
        assert observations == [('started',), ('failed' if mode == 'error' else 'lost',)]
        for table in ('production_payloads', 'production_acceptances', 'production_cancellations',
                      'production_control_outbox', 'production_resume_metadata'):
            assert case.rows('SELECT count(*) FROM ' + table) == [(0,)]
        terminal = case.rows('SELECT event_id FROM production_observations ORDER BY run_sequence DESC LIMIT 1')[0][0]
        assert case.request(case.path + '/accept', 'POST', {
            'run_id': status['run_id'], 'completion_event_id': terminal,
            'expected_revision': status['revision'], 'request_key': 'error-is-not-success'})[0] == 409
        assert case.rows('SELECT count(*) FROM production_acceptances') == [(0,)]
        ordinary.wait_for(case.peer_gone, 'failure must reap its exact owned native')
        assert len([x for x in case.trace() if x['kind'] == 'turn']) == 1
    finally:
        case.cleanup()


if __name__ == '__main__':
    for mode in ('error', 'foreign-error', 'malformed-error'):
        exercise(mode)
        print('Claude failure HTTP passed:', mode)
