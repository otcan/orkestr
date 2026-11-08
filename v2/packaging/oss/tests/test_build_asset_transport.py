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

    def exercise_cloudflared(self, arch, valid_digest=False, upstream_failure=False):
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
            curl.write_text('#!' + sys.executable + '\n' +
                            'import json,os,sys\nfrom pathlib import Path\n'
                            'args=sys.argv[1:]\n'
                            'Path(os.environ["REQUEST_ARGS"]).write_text(json.dumps(args))\n'
                            'if os.environ["UPSTREAM_FAILURE"]=="1":sys.exit(22)\n'
                            'Path(args[args.index("-o")+1]).write_bytes(Path(os.environ["PAYLOAD"]).read_bytes())\n')
            curl.chmod(0o700)
            self.assertEqual(tail.count('/usr/local/bin/cloudflared'), 1)
            tail = tail.replace('/usr/local/bin/cloudflared', shlex.quote(str(binary / 'cloudflared')))
            self.assertNotIn('/usr/local/', tail)
            self.assertNotIn('/var/lib/', tail)
            result = subprocess.run(['/bin/sh', '-eu', '-c', tail], timeout=10,
                                    capture_output=True, text=True,
                                    env={'PATH': str(binary) + ':/usr/bin:/bin', 'TMPDIR': str(root),
                                         'TARGETARCH': arch, 'PAYLOAD': str(data),
                                         'REQUEST_ARGS': str(arguments),
                                         'UPSTREAM_FAILURE': '1' if upstream_failure else '0'})
            requested = json.loads(arguments.read_text()) if arguments.exists() else None
            return result.returncode, (binary / 'cloudflared').exists(), requested, result.stdout

    @unittest.skipUnless(shutil.which('sha256sum') and shutil.which('install'), 'requires Linux shell tools')
    def test_both_architectures_verify_before_installing(self):
        for arch, (asset, _) in PINS.items():
            with self.subTest(architecture=arch):
                code, installed, request, output = self.exercise_cloudflared(arch, valid_digest=True)
                self.assertEqual(code, 0)
                self.assertTrue(installed)
                self.assertIn('cloudflared synthetic', output)
                self.assertIn('https://api.github.com/repos/cloudflare/cloudflared/releases/assets/' + asset, request)
                self.assertIn('Accept: application/octet-stream', request)
                self.assertIn('X-GitHub-Api-Version: 2022-11-28', request)
                self.assertEqual(request[request.index('--retry') + 1], '2')

    @unittest.skipUnless(shutil.which('sha256sum') and shutil.which('install'), 'requires Linux shell tools')
    def test_wrong_digest_and_failed_download_never_install_or_execute(self):
        for failure in (False, True):
            with self.subTest(upstream_failure=failure):
                code, installed, _, output = self.exercise_cloudflared('amd64', upstream_failure=failure)
                self.assertNotEqual(code, 0)
                self.assertFalse(installed)
                self.assertEqual(output, '')

    @unittest.skipUnless(shutil.which('sha256sum') and shutil.which('install'), 'requires Linux shell tools')
    def test_unknown_architecture_never_requests_an_asset(self):
        code, installed, request, _ = self.exercise_cloudflared('unknown')
        self.assertNotEqual(code, 0)
        self.assertFalse(installed)
        self.assertIsNone(request)


if __name__ == '__main__':
    unittest.main()
