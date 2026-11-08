"""Real HTTP failures must not weaken pinned provider verification."""
import contextlib
import http.server
import importlib.util
import io
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
    def test_all_pinned_codex_assets_use_exact_anonymous_api_requests(self):
        expected = {
            'codex-x86_64-unknown-linux-musl.tar.gz': 645227929,
            'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz': 645227482,
            'codex-aarch64-unknown-linux-musl.tar.gz': 645213549,
            'codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz': 645213791,
        }
        self.assertEqual(dict(providers.GITHUB_ASSET_IDS),
                         {providers.CODEX + name: asset for name, asset in expected.items()})
        pinned = {url for rows in providers.ASSETS.values() for _, url, _, _ in rows
                  if url.startswith(providers.CODEX)}
        self.assertEqual(pinned, set(providers.GITHUB_ASSET_IDS))
        for url, asset in providers.GITHUB_ASSET_IDS.items():
            with self.subTest(asset=asset), patch.object(
                    providers.urllib.request, 'urlopen', return_value=io.BytesIO(b'asset')) as opened:
                self.assertEqual(providers.download(url), b'asset')
                request = opened.call_args.args[0]
                self.assertEqual(request.full_url,
                                 'https://api.github.com/repos/openai/codex/releases/assets/' + str(asset))
                self.assertEqual(request.get_method(), 'GET')
                self.assertEqual(dict(request.header_items()),
                                 {'Accept': 'application/octet-stream',
                                  'X-github-api-version': '2022-11-28'})
                self.assertEqual(opened.call_args.kwargs, {'timeout': 120})

    def test_mapping_cannot_mutate_and_unreviewed_codex_asset_never_opens(self):
        with self.assertRaises(TypeError):
            providers.GITHUB_ASSET_IDS[providers.CODEX + 'foreign.tar.gz'] = 1
        with patch.object(providers.urllib.request, 'urlopen') as opened:
            with self.assertRaisesRegex(ValueError, 'unreviewed GitHub provider asset'):
                providers.download(providers.CODEX + 'foreign.tar.gz')
            opened.assert_not_called()

    def test_claude_registry_url_is_unchanged(self):
        for rows in providers.ASSETS.values():
            url = next(url for name, url, _, _ in rows if name == 'claude')
            with patch.object(providers.urllib.request, 'urlopen',
                              return_value=io.BytesIO(b'fixture')) as opened:
                self.assertEqual(providers.download(url), b'fixture')
                self.assertEqual(opened.call_args.args, (url,))

    def test_permanent_api_refusal_is_not_retried(self):
        url = next(iter(providers.GITHUB_ASSET_IDS))
        failure = urllib.error.HTTPError('https://api.github.com/', 403, 'Forbidden', {}, None)
        with patch.object(providers.urllib.request, 'urlopen', side_effect=failure) as opened, \
                patch.object(providers.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                providers.download(url)
            self.assertEqual(opened.call_count, 1)
            sleep.assert_not_called()

    def test_api_response_never_bypasses_existing_digest(self):
        url = next(iter(providers.GITHUB_ASSET_IDS))
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'providers'
            with patch.object(providers, 'Path', return_value=output), \
                    patch.object(providers, 'assets', return_value=[('codex', url, 'sha256', '0' * 64)]), \
                    patch.object(providers.urllib.request, 'urlopen',
                                 return_value=io.BytesIO(b'wrong asset')) as opened:
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    providers.main()
                self.assertEqual(opened.call_count, 1)
                self.assertEqual(list(output.iterdir()), [])

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
