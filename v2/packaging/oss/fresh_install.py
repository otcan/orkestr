"""Opt-in isolated Docker acceptance. Synthetic owner only; no provider login."""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import time
import urllib.error
import urllib.request


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True,
            **({'stderr': subprocess.STDOUT} if args[0] == 'logs' else {})).strip()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image', required=True)
    p.add_argument('--source', required=True)
    p.add_argument('--report', required=True, type=Path)
    a = p.parse_args()
    name = 'orkestr-fresh-' + secrets.token_hex(6)
    volumes = [name + '-state', name + '-credentials']
    created = []
    report = {'source': a.source, 'image': a.image, 'passed': False, 'real_accounts': 0,
              'provider_logins': 0, 'provider_inference': 0, 'checks': []}
    def passed(name):
        report['checks'].append(name)
    try:
        image_environment = json.loads(docker('image', 'inspect', '--format', '{{json .Config.Env}}', a.image))
        forbidden = {'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
                     'CLAUDE_CODE_OAUTH_TOKEN', 'ORKESTR_V2_BOOTSTRAP_TOKEN'}
        assert not forbidden & {item.split('=', 1)[0] for item in image_environment}
        docker('run', '--rm', '--network', 'none', '--entrypoint', '/usr/bin/python3', a.image,
               '-I', '-S', '-B', '-c',
               "from pathlib import Path; assert not list(Path('/state').iterdir()); "
               "assert not list(Path('/credentials').iterdir()); "
               "assert not Path('/root/.codex/auth.json').exists(); "
               "assert not Path('/root/.claude/.credentials.json').exists()")
        passed('image has empty state/credential roots and no provider secret environment')
        for volume in volumes:
            docker('volume', 'create', volume)
            created.append(volume)
        docker('run', '--rm', '--network', 'none', '--entrypoint', '/usr/bin/python3',
               '--mount', f'type=volume,src={volumes[0]},dst=/state',
               '--mount', f'type=volume,src={volumes[1]},dst=/credentials', a.image,
               '-I', '-S', '-B', '-c',
               "from pathlib import Path; assert not list(Path('/state').iterdir()); "
               "assert not list(Path('/credentials').iterdir())")
        passed('new named volumes are empty before initialization')
        docker('run', '--detach', '--name', name, '--memory', '2g', '--cpus', '2', '--pids-limit', '256',
               '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
               '--publish', '127.0.0.1::19823', '--mount', f'type=volume,src={volumes[0]},dst=/state',
               '--mount', f'type=volume,src={volumes[1]},dst=/credentials', a.image)
        inspected = json.loads(docker('inspect', '--format', '{{json .Mounts}}', name))
        assert all(m['Type'] == 'volume' for m in inspected), 'host bind mount refused'
        passed('only fresh named volumes; no host mounts/accounts')
        port = json.loads(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name))['19823/tcp'][0]
        assert port['HostIp'] == '127.0.0.1'
        base = 'http://127.0.0.1:' + port['HostPort']
        def request(path, body=None, headers=None, raw=False):
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=data,
                    headers={'Content-Type': 'application/json', 'Host': '127.0.0.1:19822', **(headers or {})})
            with urllib.request.urlopen(req, timeout=10) as response:
                result = response.read()
                return result if raw else json.loads(result)
        deadline = time.monotonic() + 120
        while True:
            try:
                health = request('/api/v2/health')
                break
            except (OSError, ValueError):
                if docker('inspect', '--format', '{{.State.Running}}', name) != 'true':
                    report['startup_log_tail'] = docker('logs', '--tail', '12', name)[-4096:]
                    raise RuntimeError('fresh container exited before health')
                assert time.monotonic() < deadline, 'fresh container did not become healthy'
                time.sleep(1)
        assert health['status'] == 'ok' and health['build']['source_commit'] == a.source
        report['version'] = health['build']['version']
        passed('HTTP health has the exact public build identity')
        assert b'orkestr_v2_ui.js' in request('/', raw=True)
        assert len(request('/orkestr_v2_ui_bg.wasm', raw=True)) > 1000
        passed('real web index and WASM served')
        bootstrap = docker('exec', '--user', '10001:10001', name, 'cat', '/state/bootstrap.token')
        credentials = {'username': 'synthetic-owner', 'password': secrets.token_urlsafe(32)}
        try:
            request('/api/v2/setup', credentials)
            raise AssertionError('setup accepted without bootstrap')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        setup = request('/api/v2/setup', credentials, {'x-orkestr-bootstrap': bootstrap})
        passed('setup rejects unauthenticated callers; synthetic owner created')
        session = request('/api/v2/machine/session', credentials)
        assert session['global_conversation_id'] == setup['global_conversation_id']
        headers = {'Authorization': 'Bearer ' + session['token']}
        conversation = request('/api/v2/conversations', {'client_request_id': 'fresh-install-thread',
                                'name': 'Synthetic fresh thread'}, headers)['conversation_id']
        assert conversation != setup['global_conversation_id']
        passed('owner login and new conversation via supported API')
        browser = request('/api/v2/browser/session', credentials, {'Origin': 'http://127.0.0.1:19822'})
        assert browser['global_conversation_id'] == setup['global_conversation_id']
        passed('browser cookie/CSRF login with the exact configured origin')
        assert 'provider_login_required' in docker('logs', name)
        native = docker('exec', name, '/opt/orkestr/providers/codex', '--version')
        assert '0.163.0' in native
        native = docker('exec', name, '/opt/orkestr/providers/claude', '--version')
        assert '2.1.295' in native
        passed('pinned official CLI executables present; no login or inference')
        namespace = subprocess.run(['docker', 'exec', '--user', '10001:10001', name,
                    '/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--die-with-parent',
                    '--bind', '/', '/', '--proc', '/proc', '--', '/bin/true'],
                    capture_output=True, text=True, timeout=10)
        report['unprivileged_bubblewrap'] = {'available': namespace.returncode == 0,
            'exit_code': namespace.returncode,
            'profile': 'container-full-access; provider commands use the existing direct profile, not nested namespaces'}
        caps = docker('exec', '--user', '10001:10001', name, '/usr/bin/python3', '-I', '-S', '-B', '-c',
                      "print(next(s.split()[1] for s in open('/proc/self/status') if s.startswith('CapEff:')))")
        assert int(caps, 16) == 0
        passed('provider UID has zero effective capabilities; nested namespace outcome recorded')
        refused = subprocess.run(['docker', 'exec', name, '/usr/bin/python3', '-I', '-S', '-B',
                    '/opt/orkestr/source/v2/packaging/oss/runtime.py', 'configure'],
                    capture_output=True, text=True, timeout=65)
        assert refused.returncode != 0
        passed('provider configuration refuses missing CLI login')
        # Validate the real generated package using a synthetic auth *placeholder*.
        # Never activate it or write owner.json: provider launch remains disabled.
        composition = '''
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('oss_runtime','/opt/orkestr/source/v2/packaging/oss/runtime.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
auth=Path('/credentials/codex/auth.json')
assert not auth.exists()
r.write_private(auth,'{"fixture":"synthetic-login-placeholder"}')
try:
    package=r.prepare(json.load(sys.stdin))
    assert (package/'release.json').is_file()
    assert not Path('/state/owner.json').exists()
    sys.path[:0]=[str(package/'package'),str(package/'package/broker')]
    from codex_service.package import Package
    from codex_service.profile import Configuration
    selected=Package(package/'package')
    command,descriptors=Configuration(selected).isolated_command()
    assert command[0]=='/usr/bin/env' and '/usr/bin/bwrap' not in command and not descriptors
    from claude_connector import ClaudeConfiguration
    claude=ClaudeConfiguration.load(package/'package/claude-private.json')
    assert claude.new_session().uncontained is True
    print('generated_package_validation_passed_without_activation')
finally:
    auth.unlink()
'''
        result = subprocess.run(['docker', 'exec', '-i', name, '/usr/bin/python3', '-I', '-S', '-B', '-c', composition],
                    input=json.dumps({'owner_id': browser['owner_id'],
                                      'conversation_id': setup['global_conversation_id']}),
                    capture_output=True, text=True, timeout=120)
        assert result.returncode == 0 and 'generated_package_validation_passed_without_activation' in result.stdout, \
            'generated manager package validation failed: ' + result.stderr[-2000:]
        passed('real closed manager package validates with a synthetic auth placeholder; never activated')
        docker('restart', '--time', '45', name)
        deadline = time.monotonic() + 60
        while True:
            try:
                after = request('/api/v2/machine/session', credentials)
                break
            except OSError:
                assert time.monotonic() < deadline, 'restart did not become ready'
                time.sleep(1)
        assert after['global_conversation_id'] == setup['global_conversation_id']
        passed('restart preserves owner and conversation in the fresh state volume')
        report['passed'] = True
        report['provider_acceptance'] = 'requires manual owner CLI login and first-answer acceptance'
    finally:
        # Exact resources created by this invocation only. Never global prune/down -v.
        subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for volume in created:
            subprocess.run(['docker', 'volume', 'rm', volume], check=True, stdout=subprocess.DEVNULL)
        a.report.parent.mkdir(parents=True, exist_ok=True)
        a.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
