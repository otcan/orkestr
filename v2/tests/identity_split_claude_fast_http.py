"""Three existing synthetic Claude inputs, with cold-retirement and warm Fast.

This adapts the existing host fixture to the same Fast sequence as Codex. No
provider API, extra message, live account or configured profile is introduced.
"""
import json
import os

from identity_split_host_http import HostRehearsal
from identity_split_service_http import Rehearsal, wait


class ClaudeFastRehearsal(HostRehearsal):
    def __init__(self, binary):
        super().__init__(binary, 'claude')

    def request(self, path, method='GET', body=None, headers=None):
        response = super().request(path, method, body, headers)
        if method == 'POST' and path.endswith('/window') and response[0] == 201:
            def completed():
                assert not self.pump_errors, self.pump_errors
                rows = self.rows('SELECT role,state FROM production_runs WHERE message_id=?',
                                 (body['input_message_id'],))
                return len(rows) == 2 and {r['role'] for r in rows} == {'deep', 'fast'} and all(
                    r['state'] == 'succeeded' for r in rows)
            wait(completed, 'existing Claude Deep and Fast accepted', seconds=30)
        return response

    def run(self):
        report = Rehearsal.run(self)
        path = '/api/v2/conversations/' + self.conversation
        drain = self.package.data / 'deploy-drain.request'

        def drain_window():
            drain.touch(mode=0o600)
            os.chown(drain, self.package.authority_uid, self.package.authority_gid)
            def retired():
                assert not self.pump_errors, self.pump_errors
                code, window = self.request(path + '/window')
                return code == 200 and window['state'] == 'closed' and all(
                    row['state'] == 'exited' for row in self.claims())
            wait(retired, 'original Claude roles retired', seconds=20)
            drain.unlink()
            wait(lambda: json.loads((self.package.data / 'deploy-drain.status.json').read_text())['draining'] is False,
                 'operator drain released', seconds=5)

        drain_window()
        for number in (2, 3):
            code, window = self.request(path + '/window'); assert code == 200
            key = 'synthetic-split-' + str(number)
            code, receipt = self.request(path + '/messages', 'POST', {
                'client_message_id': key, 'text': 'synthetic ordinary HTTP input ' + str(number),
                'author': 'owner'})
            assert code == 202, (code, receipt)
            closed = window['state'] == 'closed'
            code, opened = self.request(path + '/window', 'POST', {
                'request_key': 'window:' + key, 'input_message_id': receipt['message_id'],
                'input_event_id': receipt['event_id'], 'input_request_key': key,
                'expected_generation': window['generation'],
                'window_id': None if closed else window['window_id'],
                'predecessor_window_id': window['window_id'] if closed else None})
            assert code == 201, (code, opened)
        drain_window()
        rows = self.rows('SELECT role,native_session_id,state FROM production_runs ORDER BY rowid')
        assert len(rows) == 6 and all(row['state'] == 'succeeded' for row in rows), rows
        fast = [row['native_session_id'] for row in rows if row['role'] == 'fast']
        deep = [row['native_session_id'] for row in rows if row['role'] == 'deep']
        assert len(fast) == len(deep) == 3 and fast[0] != fast[1] == fast[2], rows
        assert len(set(deep)) == 1 and len(self.rows('SELECT id FROM messages')) == 3
        report.update(original_inputs_replayed=False, managed_host=True,
                      fresh_after_window_retirement=True, warm_within_window=True)
        return report
