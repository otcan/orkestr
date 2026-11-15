"""Exercise the published read-only diagnostic without a Docker daemon."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'check-docker.sh'
FAKE = '''import json,os,sys,time
from pathlib import Path
path=Path(os.environ['SYNTHETIC_DOCKER_STATE'])
state=json.loads(path.read_text())
args=sys.argv[1:]
state.setdefault('calls',[]).append(args)
if state.get('hang')==args[0]:
    state['hung_pid']=os.getpid()
    path.write_text(json.dumps(state))
    time.sleep(30)
path.write_text(json.dumps(state))
if args[:2]==['context','inspect']:
    print(state.get('endpoint','unix:///synthetic/docker.sock'))
    sys.exit(state.get('context_exit',0))
if args[0]=='info':
    print(state.get('warning',''),file=sys.stderr)
    print(state.get('platform','linux|x86_64'))
    sys.exit(state.get('engine_exit',0))
sys.exit(99)
'''


class DockerCheck(unittest.TestCase):
    def run_check(self, state, *args, docker_host=None, docker_context=None):
        with tempfile.TemporaryDirectory(prefix='synthetic docker check ') as folder:
            root = Path(folder)
            executable = root / 'docker'
            executable.write_text('#!' + sys.executable + '\n' + FAKE)
            executable.chmod(0o755)
            state_file = root / 'state.json'
            state_file.write_text(json.dumps(state))
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       SYNTHETIC_DOCKER_STATE=str(state_file))
            env.pop('DOCKER_HOST', None)
            env.pop('DOCKER_CONTEXT', None)
            if docker_host is not None:
                env['DOCKER_HOST'] = docker_host
            if docker_context is not None:
                env['DOCKER_CONTEXT'] = docker_context
            result = subprocess.run(['bash', str(SCRIPT), *args], env=env,
                                    capture_output=True, text=True, timeout=8)
            after = json.loads(state_file.read_text())
            # Every path, including refusals, must use only these read calls.
            for call in after.get('calls', []):
                self.assertIn(call[:2], [['context', 'inspect'], ['info', '--format']])
            return result, after

    def test_linux_architecture_aliases_and_stderr_warning(self):
        for raw, expected in [('amd64', 'amd64'), ('x86_64', 'amd64'),
                              ('arm64', 'arm64'), ('aarch64', 'arm64')]:
            with self.subTest(raw=raw):
                result, _ = self.run_check({'platform': 'linux|' + raw,
                                            'warning': 'synthetic unrelated warning'})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('linux/' + expected, result.stdout)
                self.assertNotIn('synthetic unrelated warning', result.stdout)

    def test_remote_context_and_host_override_never_contact_the_engine(self):
        for override in (None, 'ssh://synthetic.example'):
            result, state = self.run_check({'endpoint': 'ssh://synthetic.example'}, docker_host=override)
            self.assertEqual(result.returncode, 2)
            self.assertIn('No remote engine was contacted', result.stderr)
            self.assertFalse(any(c[0] == 'info' for c in state.get('calls', [])))

    def test_offline_engine_and_unsupported_platform(self):
        for state in ({'engine_exit': 1}, {'platform': 'windows|amd64'}, {'context_exit': 1}):
            result, _ = self.run_check(state)
            self.assertEqual(result.returncode, 2)

    def test_context_override_takes_precedence_over_local_host(self):
        result, state = self.run_check({'endpoint': 'ssh://synthetic.example'},
                                       docker_host='unix:///synthetic/docker.sock',
                                       docker_context='synthetic-remote')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(state['calls'][0][2], 'synthetic-remote')
        self.assertFalse(any(c[0] == 'info' for c in state['calls']))

    def test_hung_context_and_engine_are_bounded_and_reaped(self):
        for command in ('context', 'info'):
            started = time.monotonic()
            result, state = self.run_check({'hang': command}, '--timeout', '1')
            self.assertEqual(result.returncode, 2)
            self.assertIn('timed out', result.stderr)
            self.assertLess(time.monotonic() - started, 5)
            with self.assertRaises(ProcessLookupError):
                os.kill(state['hung_pid'], 0)

    def test_invalid_options_never_call_docker(self):
        for args in (('--timeout', '0'), ('--timeout', '61'), ('--timeout', '01'), ('--other',)):
            result, state = self.run_check({}, *args)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(state.get('calls', []), [])

    def test_help_is_read_only(self):
        result, state = self.run_check({}, '--help')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(state.get('calls', []), [])

    def test_missing_docker_has_an_actionable_error(self):
        with tempfile.TemporaryDirectory() as folder:
            # Bash is selected by absolute path; Docker is absent from PATH.
            result = subprocess.run([shutil.which('bash'), str(SCRIPT)],
                                    env={'PATH': folder}, text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Docker CLI missing', result.stderr)


if __name__ == '__main__':
    unittest.main()
