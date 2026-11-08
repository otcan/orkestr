"""Real HTTP failures must not weaken pinned provider verification."""
import contextlib
import http.server
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location(
    'provider_downloads', Path(__file__).resolve().parents[1] / 'fetch_providers.py')
providers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(providers)


@contextlib.contextmanager
def upstream(statuses, body=b'pinned-test-content'):
    class Handler(http.server.BaseHTTPRequestHandler):
        calls = 0

        def do_GET(self):
            status = statuses[min(type(self).calls, len(statuses) - 1)]
            type(self).calls += 1
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:' + str(server.server_port), Handler
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class ProviderDownloadTests(unittest.TestCase):
    def test_transient_upstream_failure_can_recover(self):
        with upstream([504, 200]) as (url, handler), patch.object(providers.time, 'sleep'):
            self.assertEqual(providers.download(url), b'pinned-test-content')
            self.assertEqual(handler.calls, 2)

    def test_permanent_http_failure_is_not_retried(self):
        with upstream([404, 200]) as (url, handler), patch.object(providers.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError) as raised:
                providers.download(url)
            self.assertEqual(raised.exception.code, 404)
            self.assertEqual(handler.calls, 1)
            sleep.assert_not_called()

    def test_persistent_outage_still_fails(self):
        with upstream([503]) as (url, handler), patch.object(providers.time, 'sleep'):
            with self.assertRaises(urllib.error.HTTPError) as raised:
                providers.download(url)
            self.assertEqual(raised.exception.code, 503)
            self.assertEqual(handler.calls, 3)

    def test_successful_download_with_wrong_digest_is_not_retried_or_installed(self):
        with upstream([200]) as (url, handler), tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'providers'
            with patch.object(providers, 'Path', return_value=output), \
                    patch.object(providers, 'assets', return_value=[('codex', url, 'sha256', '0' * 64)]):
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    providers.main()
            self.assertEqual(handler.calls, 1)
            self.assertEqual(list(output.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
