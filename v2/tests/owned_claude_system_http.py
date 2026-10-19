"""Actual HTTP metadata handling preserves text and explicit acceptance authority."""
from pathlib import Path
import shutil
import owned_claude_http as claude
import owned_execution_http as ordinary


class SystemCase(claude.ClaudeCase):
    def configure(self, mode):
        super().configure(mode)
        shutil.copyfile(Path(__file__).with_name('owned_claude_system_peer.py'),
                        self.root / 'synthetic-provider')


def exercise(mode):
    case = SystemCase()
    try:
        case.setup(); case.stop(); case.configure(mode); case.start(configured=True)
        ordinary.wait_for(case.native_ready, 'metadata ACK is not native init')
        assert case.message()[0] == 202
        ordinary.wait_for(lambda: case.phase('running'), 'genuine init before metadata')
        assert case.rows('SELECT kind FROM production_observations') == [('started',)]
        (case.workspace / 'release-metadata').touch()
        ordinary.wait_for(lambda: any(x['kind'] == 'metadata_attempt' for x in case.trace()), 'native metadata attempt captured before refusal can reap it')
        if mode == 'metadata':
            assert case.rows("SELECT count(*) FROM production_observations WHERE kind='progress'") == [(0,)]
            (case.workspace / 'release-text').touch()
            status = ordinary.wait_for(lambda: case.phase('awaiting_acceptance'), 'text result is a proposal')
            assert case.rows('SELECT kind FROM production_observations ORDER BY run_sequence') == [
                ('started',), ('progress',), ('completed_proposal',)]
            assert case.rows('SELECT count(*) FROM production_acceptances') == [(0,)]
            code, payload, _ = case.request(case.path + '/payloads/' + status['progress']['payload_id'])
            assert code == 200 and payload['text'] == 'Synthetic actual text'
            body = {'run_id': status['run_id'], 'completion_event_id': status['acceptance_candidate']['completion_event_id'],
                    'expected_revision': status['revision'], 'request_key': 'metadata-not-acceptance'}
            code, receipt, _ = case.request(case.path + '/accept', 'POST', body)
            assert code == 200 and receipt['outcome'] == 'succeeded'
            assert case.request(case.path + '/accept', 'POST', body)[:2] == (200, receipt)
        else:
            status = ordinary.wait_for(lambda: case.phase('blocked'), 'invalid metadata quarantines child')
            assert status['progress'] is None and status.get('acceptance_candidate') is None
            assert case.rows('SELECT kind FROM production_observations ORDER BY run_sequence') == [('started',), ('lost',)]
            assert case.rows('SELECT count(*) FROM production_payloads') == [(0,)]
            assert case.rows('SELECT count(*) FROM production_acceptances') == [(0,)]
        for table in ('production_cancellations', 'production_control_outbox'):
            assert case.rows('SELECT count(*) FROM ' + table) == [(0,)]
        assert case.rows("SELECT count(*) FROM production_observations WHERE kind='stopped'") == [(0,)]
        ordinary.wait_for(case.peer_gone, 'exact owned native cleanup')
        assert len([x for x in case.trace() if x['kind'] == 'turn']) == 1
    finally:
        case.cleanup()


if __name__ == '__main__':
    for mode in ('metadata', 'foreign-metadata', 'duplicate-init'):
        exercise(mode)
        print('Claude system HTTP passed:', mode)
