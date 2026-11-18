"""Run the actual image download tail with an offline synthetic curl peer."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[4]
PINS = {
    'amd64': ('692817008', '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872'),
    'arm64': ('692818763', '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775'),
}
API_ASSET = 'https://api.github.com/repos/cloudflare/cloudflared/releases/assets/'
# The same official assets over the public release link (sha256 checked 2026-11-18).
PUBLIC_LINK = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-'


class BuildAssetTransportTests(unittest.TestCase):
    def test_gitleaks_keeps_its_reviewed_digest_on_the_anonymous_api_route(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        line = next(line.strip() for line in workflow.splitlines()
                    if line.strip().startswith('curl ') and 'gitleaks' in line)
        argv = shlex.split(line)
        self.assertIn('https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058', argv)
        self.assertIn('Accept: application/octet-stream', argv)
        self.assertIn('X-GitHub-Api-Version: 2022-11-28', argv)
        self.assertNotIn('Authorization:', line)
        self.assertIn('--fail', argv)
        self.assertEqual(argv[argv.index('--retry') + 1], '2')
        digest = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
        self.assertLess(workflow.index(digest), workflow.index('tar -xzf'))
        self.assertIn('sha256sum --check --status', workflow)

    def test_gitleaks_fallback_is_the_same_anonymous_asset(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        lines = [line.strip() for line in workflow.splitlines()
                 if line.strip().startswith('curl ') and 'gitleaks' in line]
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].endswith('&& api_ok=yes'))
        self.assertNotIn('||', workflow[workflow.index(lines[0]):workflow.index('sha256sum --check --status')])
        fallback = shlex.split(lines[1])
        self.assertIn('https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
                      fallback)
        self.assertNotIn('Authorization:', lines[1])
        self.assertNotIn('--header', fallback)
        self.assertIn('--fail', fallback)
        self.assertLess(workflow.index(lines[0]), workflow.index('if [ "$api_ok" != yes ]; then'))
        self.assertLess(workflow.index('if [ "$api_ok" != yes ]; then'), workflow.index(lines[1]))
        self.assertLess(workflow.index(lines[1]), workflow.index('sha256sum --check --status'))

    def test_cloudflared_fallback_is_the_same_anonymous_asset_before_the_digest_check(self):
        source = (ROOT / 'Dockerfile').read_text()
        lines = [line.strip() for line in source.splitlines() if 'curl -fsSL' in line]
        self.assertEqual(len(lines), 2)
        api, public = lines
        self.assertIn('"' + API_ASSET + '${cloudflared_asset}"', api)
        self.assertIn("--header 'Accept: application/octet-stream'", api)
        self.assertIn("--header 'X-GitHub-Api-Version: 2022-11-28'", api)
        self.assertTrue(api.endswith('; then cloudflared_api_ok=yes; fi \\'))
        self.assertTrue(public.startswith('&& if [ "$cloudflared_api_ok" != yes ]; then curl '))
        self.assertIn('"' + PUBLIC_LINK + '${cloudflared_arch}"', public)
        self.assertNotIn('--header', public)
        self.assertNotIn('Authorization', source)
        self.assertNotIn('||', source[source.index(api):source.index('sha256sum --check --status')])
        self.assertLess(source.index(api), source.index(public))
        self.assertLess(source.index(public), source.index('sha256sum --check --status'))
        self.assertLess(source.index('sha256sum --check --status'), source.index('install -m 0755'))

    def exercise_cloudflared(self, arch, valid_digest=False, fail_routes=(), public_payload=None):
        source = (ROOT / 'Dockerfile').read_text()
        anchor = '  && case "${TARGETARCH}" in \\\n'
        self.assertEqual(source.count(anchor), 1)
        tail = 'case "${TARGETARCH}" in \\\n' + source.split(anchor)[1].split('  && rm -rf /var/lib/apt/lists/*')[0]
        tail = tail.replace('\\\n', ' ')
        payload = b'#!/bin/sh\nprintf "cloudflared synthetic\\n"\n'
        for asset, digest in PINS.values():
            self.assertIn(asset, tail)
            self.assertIn(digest, tail)
            if valid_digest:
                tail = tail.replace(digest, hashlib.sha256(payload).hexdigest())
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            binary = root / 'bin'
            binary.mkdir()
            data = root / 'payload'
            data.write_bytes(payload)
            arguments = root / 'request.json'
            curl = binary / 'curl'
            public = root / 'public-payload'
            public.write_bytes(payload if public_payload is None else public_payload)
            # Records every request; fails the routes named in FAIL_ROUTES like curl -f does.
            curl.write_text('#!' + sys.executable + '\n' +
                            'import json,os,sys\nfrom pathlib import Path\n'
                            'args=sys.argv[1:]\n'
                            'log=Path(os.environ["REQUEST_ARGS"])\n'
                            'calls=json.loads(log.read_text()) if log.exists() else []\n'
                            'log.write_text(json.dumps(calls+[args]))\n'
                            'route="api" if any(a.startswith("https://api.github.com/") for a in args) else "public"\n'
                            'if route in os.environ["FAIL_ROUTES"].split(","):sys.exit(22)\n'
                            'source=os.environ["PAYLOAD"] if route=="api" else os.environ["PUBLIC_PAYLOAD"]\n'
                            'Path(args[args.index("-o")+1]).write_bytes(Path(source).read_bytes())\n')
            curl.chmod(0o700)
            self.assertEqual(tail.count('/usr/local/bin/cloudflared'), 1)
            tail = tail.replace('/usr/local/bin/cloudflared', shlex.quote(str(binary / 'cloudflared')))
            self.assertNotIn('/usr/local/', tail)
            self.assertNotIn('/var/lib/', tail)
            result = subprocess.run(['/bin/sh', '-eu', '-c', tail], timeout=10,
                                    capture_output=True, text=True,
                                    env={'PATH': str(binary) + ':/usr/bin:/bin', 'TMPDIR': str(root),
                                         'TARGETARCH': arch, 'PAYLOAD': str(data),
                                         'PUBLIC_PAYLOAD': str(public),
                                         'REQUEST_ARGS': str(arguments),
                                         'FAIL_ROUTES': ','.join(fail_routes)})
            requests = json.loads(arguments.read_text()) if arguments.exists() else None
            return result.returncode, (binary / 'cloudflared').exists(), requests, result.stdout

    def assert_api_request(self, request, asset):
        self.assertIn(API_ASSET + asset, request)
        self.assertIn('Accept: application/octet-stream', request)
        self.assertIn('X-GitHub-Api-Version: 2022-11-28', request)
        self.assertEqual(request[request.index('--retry') + 1], '2')

    @unittest.skipUnless(shutil.which('sha256sum') and shutil.which('install'), 'requires Linux shell tools')
    def test_both_architectures_verify_before_installing(self):
        for arch, (asset, _) in PINS.items():
            with self.subTest(architecture=arch):
                code, installed, requests, output = self.exercise_cloudflared(arch, valid_digest=True)
                self.assertEqual(code, 0)
                self.assertTrue(installed)
                self.assertIn('cloudflared synthetic', output)
                # A working API route is the only request; the public link is not touched.
                self.assertEqual(len(requests), 1)
                self.assert_api_request(requests[0], asset)

    @unittest.skipUnless(shutil.which('sha256sum') and shutil.which('install'), 'requires Linux shell tools')
    def test_api_refusal_falls_back_to_the_anonymous_public_link_before_verifying(self):
        for arch, (asset, _) in PINS.items():
            with self.subTest(architecture=arch):
                code, installed, requests, output = self.exercise_cloudflared(
                    arch, valid_digest=True, fail_routes=('api',))
                self.assertEqual(code, 0)
                self.assertTrue(installed)
                self.assertIn('cloudflared synthetic', output)
                self.assertEqual(len(requests), 2)
                self.assert_api_request(requests[0], asset)
                fallback = requests[1]
                self.assertEqual([arg for arg in fallback if arg.startswith('https://')], [PUBLIC_LINK + arch])
                self.assertNotIn('--header', fallback)
                self.assertFalse(any('Authorization' in arg for arg in fallback))
                self.assertIn('-fsSL', fallback)
                self.assertEqual(fallback[fallback.index('--retry') + 1], '2')
                self.assertEqual(fallback[fallback.index('-o') + 1], requests[0][requests[0].index('-o') + 1])

    @unittest.skipUnless(shutil.which('sha256sum') and shutil.which('install'), 'requires Linux shell tools')
    def test_wrong_digest_and_failed_download_never_install_or_execute(self):
        cases = {
            'api digest mismatch': dict(),
            'both routes refused': dict(valid_digest=True, fail_routes=('api', 'public')),
            'fallback digest mismatch': dict(valid_digest=True, fail_routes=('api',),
                                             public_payload=b'#!/bin/sh\nprintf "other asset\\n"\n'),
        }
        for name, case in cases.items():
            with self.subTest(case=name):
                code, installed, requests, output = self.exercise_cloudflared('amd64', **case)
                self.assertNotEqual(code, 0)
                self.assertFalse(installed)
                self.assertEqual(output, '')
                self.assertEqual(len(requests), 1 if name == 'api digest mismatch' else 2)

    @unittest.skipUnless(shutil.which('sha256sum') and shutil.which('install'), 'requires Linux shell tools')
    def test_unknown_architecture_never_requests_an_asset(self):
        code, installed, requests, _ = self.exercise_cloudflared('unknown')
        self.assertNotEqual(code, 0)
        self.assertFalse(installed)
        self.assertIsNone(requests)


if __name__ == '__main__':
    unittest.main()
