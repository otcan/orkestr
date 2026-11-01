"""Run both real installers against fake Docker/gh processes, on each host OS."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
INSTALLERS = HERE.parent
IMAGE = 'orkestr-oss-test:e7c3e890b9f10bd2c327d0ecdff4c41d008206ef'
POWERSHELL = os.environ.get('ORKESTR_TEST_POWERSHELL', 'pwsh')


class InstallerCases:
    kind = None

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='orkestr installer ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.state_file = self.root / 'fake-state.json'
        for tool in ('docker', 'gh'):
            if os.name == 'nt':
                # Batch forwarding interprets Go-template pipes as cmd pipes;
                # a PowerShell shim preserves the original argument array.
                python_path = str(sys.executable).replace("'", "''")
                client_path = str(HERE / 'installer_client.py').replace("'", "''")
                (self.bin / (tool + '.ps1')).write_text(
                    f"& '{python_path}' '{client_path}' {tool} @args\nexit $LASTEXITCODE\n")
            else:
                executable = self.bin / tool
                executable.write_text(f'#!{sys.executable}\nimport runpy,sys\nsys.argv=[{str(HERE / "installer_client.py")!r},{tool!r},*sys.argv[1:]]\nrunpy.run_path(sys.argv[0],run_name="__main__")\n')
                executable.chmod(0o755)

    def archive(self, arch='amd64', invalid=False, zipped=False):
        folder = self.root / 'downloaded images'
        folder.mkdir(exist_ok=True)
        archive = folder / f'orkestr-oss-test-{arch}.tar.gz'
        archive.write_bytes(b'synthetic Docker archive; never loaded into a real engine')
        digest = '0' * 64 if invalid else hashlib.sha256(archive.read_bytes()).hexdigest()
        receipt = archive.with_name(archive.name + '.sha256')
        receipt.write_text(f'{digest}  {archive.name}\n')
        if zipped:
            destination = self.root / 'downloaded image.zip'
            with zipfile.ZipFile(destination, 'w') as bundle:
                bundle.write(archive, archive.name)
                bundle.write(receipt, receipt.name)
                bundle.writestr('../unexpected.txt', 'must not be extracted')
            return destination
        return archive

    def execute(self, state, archive=None, timeout=0):
        self.state_file.write_text(json.dumps(state))
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                   INSTALLER_FAKE_STATE=str(self.state_file))
        env.pop('DOCKER_HOST', None)
        if self.kind == 'powershell':
            command = [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(INSTALLERS / 'install-test.ps1'),
                       '-NoOpen', '-ReadySeconds', str(timeout)]
            if archive:
                command += ['-Archive', str(archive)]
        else:
            command = ['bash', str(INSTALLERS / 'install-test.sh'), '--no-open', '--ready-seconds', str(timeout)]
            if archive:
                command += ['--archive', str(archive)]
        result = subprocess.run(command, cwd=self.root, env=env, text=True, capture_output=True, timeout=30)
        if os.environ.get('CI') == 'true':
            print(f'{self.kind}: exit={result.returncode}; stdout={result.stdout!r}; stderr={result.stderr!r}')
        return result, json.loads(self.state_file.read_text())

    def mutation_calls(self, state):
        return [call for call in state.get('calls', []) if call[0] == 'docker' and call[1] in ('load', 'run', 'start', 'stop', 'rm', 'volume')]

    def test_installs_checked_archive_and_publishes_only_loopback(self):
        result, state = self.execute({}, self.archive())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        run = next(call for call in state['calls'] if call[:2] == ['docker', 'run'])
        self.assertEqual(run[run.index('-p') + 1], '127.0.0.1:19822:19823')
        self.assertIn('ORKESTR_OSS_LOCAL_SETUP=1', run)
        self.assertIn('orkestr-419-state:/state', run)
        self.assertEqual(run[-1], IMAGE)
        self.assertNotIn('--privileged', run)
        self.assertIn('Orkestr is ready:', result.stdout)

    def test_arm64_engine_and_zip_with_spaces(self):
        result, state = self.execute({'engine': 'linux|aarch64', 'platform': 'linux|arm64'}, self.archive('arm64', zipped=True))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / 'unexpected.txt').exists())
        self.assertTrue(any(call[:2] == ['docker', 'load'] for call in state['calls']))

    def test_corrupt_archive_never_reaches_docker_load(self):
        result, state = self.execute({}, self.archive(invalid=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stdout + result.stderr)
        self.assertEqual(self.mutation_calls(state), [])

    def test_missing_checksum_receipt_never_reaches_docker_load(self):
        archive = self.archive()
        archive.with_name(archive.name + '.sha256').unlink()
        result, state = self.execute({}, archive)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('.sha256', result.stdout + result.stderr)
        self.assertEqual(self.mutation_calls(state), [])

    def test_archive_from_the_wrong_architecture_zip_is_refused(self):
        result, state = self.execute({'engine': 'linux|arm64'}, self.archive('amd64', zipped=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('architecture', result.stdout + result.stderr)
        self.assertEqual(self.mutation_calls(state), [])

    def test_restart_reuses_the_existing_container_without_download_or_load(self):
        result, state = self.execute({'existing': True, 'running': False})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call[1] for call in self.mutation_calls(state)], ['start'])
        self.assertFalse(any(call[0] == 'gh' for call in state['calls']))

    def test_running_install_is_idempotent(self):
        result, state = self.execute({'existing': True, 'running': True})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.mutation_calls(state), [])

    def test_unrelated_container_is_left_untouched(self):
        result, state = self.execute({'existing': True, 'running': True, 'identity': 'unrelated|0.0.0.0:19822|local'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('different installation', result.stdout + result.stderr)
        self.assertEqual(self.mutation_calls(state), [])

    def test_port_conflict_is_reported_before_any_download(self):
        result, state = self.execute({'occupied': 'synthetic-old-test'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Port 19822', result.stdout + result.stderr)
        self.assertEqual(self.mutation_calls(state), [])

    def test_unsupported_engine_offline_daemon_and_remote_engine(self):
        for state in ({'engine': 'windows|x86_64'}, {'daemon': False}, {'endpoint': 'ssh://synthetic.example'}):
            result, after = self.execute(state)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.mutation_calls(after), [])

    def test_wrong_image_architecture_does_not_create_a_container(self):
        result, state = self.execute({'image': True, 'platform': 'linux|arm64'})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutation_calls(state), [])

    def test_health_failure_preserves_the_container_and_volumes(self):
        result, state = self.execute({'existing': True, 'running': True, 'health': 'starting'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('taking longer', result.stdout + result.stderr)
        self.assertEqual(self.mutation_calls(state), [])

    def test_signed_in_gh_can_download_the_matching_archive(self):
        archive = self.archive()
        result, state = self.execute({'gh_auth': True, 'gh_source': str(archive.parent)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        download = next(call for call in state['calls'] if call[:3] == ['gh', 'run', 'download'])
        self.assertIn('v2-test-image-amd64-41204535602', download)


@unittest.skipUnless(os.name != 'nt' and shutil.which('bash'), 'POSIX installer requires Bash')
class ShellInstallerTests(InstallerCases, unittest.TestCase):
    kind = 'shell'


@unittest.skipUnless(shutil.which(POWERSHELL), 'PowerShell is tested on Windows, macOS and Linux CI')
class PowerShellInstallerTests(InstallerCases, unittest.TestCase):
    kind = 'powershell'


if __name__ == '__main__':
    unittest.main()
