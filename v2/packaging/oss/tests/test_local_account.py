"""Local account setup keeps bootstrap authority on the server side."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock
import urllib.error

spec = importlib.util.spec_from_file_location('local_account', Path(__file__).resolve().parents[1] / 'local_account.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class LocalAccountTests(unittest.TestCase):
    HEADERS = {'Host': local.AUTHORITY, 'Origin': local.ORIGIN,
               'x-orkestr-local-setup': '1', 'Sec-Fetch-Site': 'same-origin',
               'Content-Type': 'application/json'}
    CREDENTIALS = {'username': 'synthetic-owner', 'password': 'synthetic-password'}
    TOKEN = 'synthetic-bootstrap-credential-not-for-browser'

    def invoke(self, method='GET', headers=None, body=None, bootstrap=TOKEN, upstream=None):
        data = json.dumps(self.CREDENTIALS if body is None else body).encode()
        request_headers = {**self.HEADERS, 'Content-Length': str(len(data)), **(headers or {})}
        handler = Mock(headers=request_headers, rfile=io.BytesIO(data))
        server = upstream if upstream is not None else Mock(return_value={'setup_required': True})
        local.account(handler, method, bootstrap, server)
        handler.reply.assert_called_once()
        status, response = handler.reply.call_args.args
        self.assertNotIn(self.TOKEN, json.dumps(response))
        self.assertNotIn(self.CREDENTIALS['password'], json.dumps(response))
        return status, response, server

    def test_remote_mode_does_not_enable_first_visitor_setup(self):
        status, _, server = self.invoke(bootstrap=None)
        self.assertEqual(status, 404)
        server.assert_not_called()

    def test_cross_origin_and_rebinding_are_rejected_before_upstream(self):
        for headers in ({'Host': 'evil.example:19822'}, {'Host': 'localhost:19822'},
                        {'Origin': 'https://evil.example'}, {'x-orkestr-local-setup': None},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-site'},
                        {'Authorization': 'Bearer synthetic'}):
            with self.subTest(headers=headers):
                status, _, server = self.invoke('POST', headers=headers)
                self.assertEqual(status, 403)
                server.assert_not_called()

    def test_post_requires_origin_even_when_custom_header_is_present(self):
        status, _, server = self.invoke('POST', headers={'Origin': None})
        self.assertEqual(status, 403)
        server.assert_not_called()

    def test_status_exposes_only_setup_state_with_no_account_details(self):
        for required in (True, False):
            upstream = Mock(return_value={'setup_required': required, 'ignored': self.TOKEN})
            status, value, _ = self.invoke(headers={'Origin': None}, upstream=upstream)
            self.assertEqual((status, value), (200, {'setup_required': required}))

    def test_password_only_browser_request_uses_private_bootstrap_upstream(self):
        upstream = Mock(return_value={'global_conversation_id': 'synthetic-conversation'})
        status, value, _ = self.invoke('POST', upstream=upstream)
        self.assertEqual((status, value), (201, {'created': True}))
        upstream.assert_called_once_with('POST', '/api/v2/setup', self.CREDENTIALS,
            {'Host': local.AUTHORITY, 'Origin': local.ORIGIN, 'x-orkestr-bootstrap': self.TOKEN})

    def test_invalid_or_oversized_body_is_not_forwarded(self):
        for body, headers, expected in (([], {}, 400), ({'username': 'owner'}, {}, 400),
                                      ({'username': 1, 'password': 'secret'}, {}, 400),
                                      (None, {'Content-Length': '4097'}, 413),
                                      (None, {'Content-Type': 'text/plain'}, 400)):
            status, _, server = self.invoke('POST', headers=headers, body=body)
            self.assertEqual(status, expected)
            server.assert_not_called()

    def test_existing_owner_validation_and_rate_limit_are_preserved(self):
        for code in (400, 409, 429, 500):
            upstream = Mock(side_effect=urllib.error.HTTPError('http://synthetic.invalid', code,
                            self.TOKEN, {}, io.BytesIO(self.TOKEN.encode())))
            status, _, _ = self.invoke('POST', upstream=upstream)
            self.assertEqual(status, code if code != 500 else 503)

    def test_unavailable_upstream_is_a_safe_retryable_error(self):
        status, _, _ = self.invoke(upstream=Mock(side_effect=OSError(self.TOKEN)))
        self.assertEqual(status, 503)


if __name__ == '__main__':
    unittest.main()
