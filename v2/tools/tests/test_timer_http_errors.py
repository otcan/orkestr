"""HTTP refusals release their response before returning structured timer errors."""
import contextlib
import io
import json
import os
import unittest
from unittest import mock
from urllib.error import HTTPError

from test_agent_timer import CONVERSATION, GRANT, PROV, TIMER


class TimerHttpErrors(unittest.TestCase):
    def test_timer_and_provisioning_refusals_close_the_response(self):
        for client, error_type in (
                (TIMER.Client('http://127.0.0.1:1', CONVERSATION, GRANT), TIMER.TimerError),
                (PROV.Api('http://127.0.0.1:1'), PROV.ProvisionError)):
            for body, expected in (
                    (b'{"code":"agent_timer_too_soon"}', 'agent_timer_too_soon'),
                    (b'not JSON', 'http_error'),
                    (b'[]', 'http_error')):
                with self.subTest(client=type(client).__name__, body=body):
                    response = io.BytesIO(body)
                    refusal = HTTPError('http://127.0.0.1:1/private-' + GRANT,
                                        422, 'synthetic ' + GRANT, {}, response)
                    # Cleanup also keeps the regression's failing pre-fix
                    # run from leaking the deliberately constructed response.
                    self.addCleanup(refusal.close)
                    with mock.patch.object(TIMER.request, 'urlopen', side_effect=refusal):
                        with self.assertRaises(error_type) as caught:
                            client.call('GET', '/synthetic-refusal')
                    self.assertEqual((caught.exception.status, caught.exception.code), (422, expected))
                    self.assertNotIn(GRANT, str(caught.exception))
                    self.assertTrue(response.closed, 'caught HTTPError response must be closed')

    def test_http_refusal_cli_preserves_secret_free_json_and_exit_status(self):
        out, err = io.StringIO(), io.StringIO()
        response = io.BytesIO(b'{"code":"agent_timer_too_soon"}')
        refusal = HTTPError('http://127.0.0.1:1/private-' + GRANT,
                            422, 'synthetic ' + GRANT, {}, response)
        self.addCleanup(refusal.close)
        with mock.patch.dict(os.environ, {'ORKESTR_V2_AGENT_TIMER_GRANT': GRANT}), \
                mock.patch.object(TIMER.request, 'urlopen', side_effect=refusal), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = TIMER.main(['--v2-url', 'http://127.0.0.1:1',
                               '--conversation', CONVERSATION, 'list'])
        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(json.loads(err.getvalue()), {
            'ok': False, 'status': 422, 'code': 'agent_timer_too_soon'})
        self.assertEqual(len(err.getvalue().splitlines()), 1)
        for forbidden in (GRANT, 'private-', 'Traceback', 'ResourceWarning'):
            self.assertNotIn(forbidden, err.getvalue())
        self.assertTrue(response.closed)


if __name__ == '__main__':
    unittest.main()
