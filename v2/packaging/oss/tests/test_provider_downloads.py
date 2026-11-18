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

    def test_permanent_api_refusal_is_not_retried_and_a_refused_fallback_still_fails(self):
        url = next(iter(providers.GITHUB_ASSET_IDS))
        failure = urllib.error.HTTPError('https://api.github.com/', 403, 'Forbidden', {}, None)
        with patch.object(providers.urllib.request, 'urlopen', side_effect=failure) as opened, \
                patch.object(providers.time, 'sleep') as sleep, patch('sys.stderr', new=io.StringIO()):
            with self.assertRaises(urllib.error.HTTPError):
                providers.download(url)
            # One API attempt, then one attempt on the public link; neither 403 is retried.
            self.assertEqual(opened.call_count, 2)
            self.assertEqual(opened.call_args_list[1].args, (url,))
            sleep.assert_not_called()

    def test_api_failure_falls_back_to_the_same_anonymous_public_link(self):
        public = 'https://github.com/openai/codex/releases/download/rust-v0.163.0/'
        expected = {
            public + 'codex-x86_64-unknown-linux-musl.tar.gz': 645227929,
            public + 'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz': 645227482,
            public + 'codex-aarch64-unknown-linux-musl.tar.gz': 645213549,
            public + 'codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz': 645213791,
        }
        self.assertEqual(dict(providers.GITHUB_ASSET_IDS), expected)
        failures = (urllib.error.HTTPError('https://api.github.com/', 403, 'Forbidden', {}, None),
                    urllib.error.URLError('unreachable'), TimeoutError('timed out'))
        for url, asset in expected.items():
            for failure in failures:
                with self.subTest(asset=asset, failure=type(failure).__name__), patch.object(
                        providers.urllib.request, 'urlopen',
                        side_effect=[failure, io.BytesIO(b'public asset')]) as opened, \
                        patch.object(providers.time, 'sleep'), patch('sys.stderr', new=io.StringIO()) as log:
                    self.assertEqual(providers.download(url), b'public asset')
                    self.assertEqual(opened.call_count, 2)
                    api, fallback = opened.call_args_list
                    self.assertEqual(api.args[0].full_url,
                                     'https://api.github.com/repos/openai/codex/releases/assets/' + str(asset))
                    # The canonical reviewed URL as a bare string: no Authorization or other header.
                    self.assertEqual(fallback.args, (url,))
                    self.assertEqual(fallback.kwargs, {'timeout': 120})
                    self.assertIn('using the public release link', log.getvalue())

    def test_transient_api_failures_are_retried_before_the_fallback(self):
        url = next(iter(providers.GITHUB_ASSET_IDS))
        busy = [urllib.error.HTTPError('https://api.github.com/', 503, 'Unavailable', {}, None) for _ in range(3)]
        with patch.object(providers.urllib.request, 'urlopen',
                          side_effect=busy + [io.BytesIO(b'public asset')]) as opened, \
                patch.object(providers.time, 'sleep') as sleep, patch('sys.stderr', new=io.StringIO()):
            self.assertEqual(providers.download(url), b'public asset')
            self.assertEqual(opened.call_count, 4)
            self.assertEqual(opened.call_args_list[3].args, (url,))
            self.assertEqual(sleep.call_count, 2)

    def test_fallback_response_never_bypasses_existing_digest(self):
        url = next(iter(providers.GITHUB_ASSET_IDS))
        failure = urllib.error.HTTPError('https://api.github.com/', 403, 'Forbidden', {}, None)
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'providers'
            with patch.object(providers, 'Path', return_value=output), \
                    patch.object(providers, 'assets', return_value=[('codex', url, 'sha256', '0' * 64)]), \
                    patch.object(providers.urllib.request, 'urlopen',
                                 side_effect=[failure, io.BytesIO(b'wrong asset')]) as opened, \
                    patch('sys.stderr', new=io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    providers.main()
                self.assertEqual(opened.call_count, 2)
                self.assertEqual(list(output.iterdir()), [])

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
