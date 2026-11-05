"""Actual Core/Root managed-host Codex Deep+Fast, fixed synthetic native only.

Both roles intentionally share an executor-private cwd. Fixed native argv,
not a mutable cwd role file, distinguish Fast. No real account or provider I/O.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from identity_split_host_http import HostRehearsal
from identity_split_service_http import GID, wait
from codex_service.profile import fast_home, fast_host_options


class FastHostRehearsal(HostRehearsal):
    def __init__(self, binary):
        super().__init__(binary, 'codex')
        try: self.configure_fast()
        except BaseException:
            self.fixture.close(); raise

    def configure_fast(self):
        self.configure_roles()
        (self.fixture.workspace / 'mode').write_text('complete')
        # A real host CODEX_HOME contains canonical auth.json. The bounded
        # fixture instead keeps its read-only account file beside the home.
        original_auth = self.fixture.auth
        original_account = self.fixture.account
        self.fixture.account = self.fixture.directory('operator-codex-home')
        canonical_auth = self.fixture.account / 'auth.json'
        shutil.copyfile(original_auth, canonical_auth)
        canonical_auth.chmod(0o600); os.chown(canonical_auth, self.uid, GID)
        self.fixture.auth = canonical_auth
        beta_path = self.package.root / 'beta.json'; beta = json.loads(beta_path.read_text())
        beta['managed_host']['environment']['CODEX_HOME'] = str(self.fixture.account)
        beta_path.write_text(json.dumps(beta))
        for profile in self.package.root.glob('profile*.json'):
            value = json.loads(profile.read_text()); value['auth_file'] = str(canonical_auth)
            profile.write_text(json.dumps(value))
        generated = self.fixture.root / 'synthetic-managed-host.c'
        source = generated.read_text()
        source = source.replace(json.dumps(str(original_auth)), 'account_path("auth.json")')
        source = source.replace(str(original_account), str(self.fixture.account))
        begin = source.index('    if (argc != 4')
        end = source.index('    if (prctl(', begin)
        expected = ['app-server', *fast_host_options(), '--listen', 'stdio://']
        checks = ' ||\n        '.join('strcmp(argv[%d],%s)' % (i, json.dumps(v))
                                        for i, v in enumerate(expected, 1))
        source = source[:begin] + '''    if (argc == 4) {
        if (strcmp(argv[1],"app-server") || strcmp(argv[2],"--listen") ||
            strcmp(argv[3],"stdio://")) return 20;
        strcpy(role,"deep");
    } else {
        if (argc != %d || %s) return 20;
        strcpy(role,"fast");
    }
''' % (len(expected) + 1, checks) + source[end:]
        source = source.replace('    read_fixed("role", role, sizeof(role));\n', '')
        # Fast's sealed channel requests a read-only thread even though the
        # operator opted the provider process into managed host access.
        source = source.replace('\\"type\\":\\"dangerFullAccess\\"', '\\"type\\":\\"%s\\"')
        source = source.replace('request, cwd, native, cwd);',
            'request, cwd, !strcmp(role,"fast") ? "readOnly" : "dangerFullAccess", native, cwd);')
        account = str(self.fixture.account)
        source = re.sub('"' + re.escape(account) + r'/([^"\n]+)"',
                        lambda m: 'account_path(' + json.dumps(m[1]) + ')', source)
        source = source.replace('"' + account + '"', 'getenv("CODEX_HOME")')
        helper = '''
static const char *account_path(const char *relative) {
    static char path[4096];
    const char *home=getenv("CODEX_HOME");
    if (!home || snprintf(path,sizeof(path),"%s/%s",home,relative)>=(int)sizeof(path)) exit(75);
    return path;
}
'''
        marker = 'static int instance, turns;'
        source = source.replace(marker, marker + '\n' + helper)
        generated.write_text(source)
        self.synthetic_sha256 = hashlib.sha256(source.encode()).hexdigest()
        subprocess.run(['/usr/bin/cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
            '-DORKESTR_TEST_AUTHORITY_CORE=' + json.dumps(str(self.package.data / 'core.sqlite3')),
            str(generated), '-o', str(self.package.root / 'native')], check=True,
            capture_output=True, env={'PATH': '/usr/bin:/bin'})
        os.chown(self.package.root / 'native', 0, GID)
        (self.package.root / 'native').chmod(0o550)
        self.refresh_manifest()
        state = type('Profile', (), {'state_root': str(self.role_accounts['fast'])})()
        self.fast_home = fast_home(state, {'HOME': str(self.fixture.home)})

    def request(self, path, method='GET', body=None, headers=None):
        # ResumeRehearsal records first-role identities immediately after this
        # returns. Prove the actual Fast run too before letting it proceed.
        response = super().request(path, method, body, headers)
        if method == 'POST' and path.endswith('/window') and response[0] == 201:
            message = body['input_message_id']
            def completed():
                assert not self.pump_errors, self.pump_errors
                rows = self.rows('SELECT role,state FROM production_runs WHERE message_id=?', (message,))
                return len(rows) == 2 and {r['role'] for r in rows} == {'deep', 'fast'} and all(
                    r['state'] == 'succeeded' for r in rows)
            wait(completed, 'actual host Deep and Fast completion', seconds=30)
        return response

    def run(self):
        report = super().run()
        traces = {}
        for role, home in [('deep', self.fixture.account), ('fast', self.fast_home)]:
            events = [json.loads(line) for line in (home / 'sessions/synthetic-role.jsonl').read_text().splitlines()]
            assert all(row['role'] == role for row in events)
            assert sum(row['kind'] == 'turn' for row in events) == 3
            assert any(row['kind'] == 'ready' and row['resumed'] for row in events)
            traces[role] = {'turns': 3, 'resumed': True}
        assert (self.fast_home / 'auth.json').is_symlink()
        assert (self.fast_home / 'auth.json').resolve() == self.fixture.auth
        report.update(codex_deep_and_fast=traces, roles_selected_by_fixed_argv=True,
            shared_mapped_cwd=True, fast_separate_codex_home=True, fast_pinned_options=list(fast_host_options()))
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary'); parser.add_argument('--expected-source', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args(); assert os.geteuid() == 0
    identity = json.loads(subprocess.check_output([args.binary, '--version', '--json']))
    assert identity.get('source_commit') == args.expected_source, identity
    os.umask(0o077)
    case = FastHostRehearsal(args.binary)
    report = {'passed': False, 'actual_provider': False, 'live_activation': False}
    try: report.update(case.run(), passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__, error=str(error), manager_errors=case.pump_errors,
            launch_claims=case.claims(), runs=case.rows('SELECT id,role,state,native_session_id FROM production_runs'))
        report['synthetic_role_events'] = {}
        for role, home in [('deep', case.fixture.account), ('fast', case.fast_home)]:
            path = home / 'sessions/synthetic-role.jsonl'
            if path.exists(): report['synthetic_role_events'][role] = [json.loads(line) for line in path.read_text().splitlines()]
        if case.process and case.process.stderr:
            os.set_blocking(case.process.stderr.fileno(), False)
            try: report['synthetic_core_stderr'] = os.read(case.process.stderr.fileno(), 16384).decode(errors='replace')
            except BlockingIOError: pass
        raise
    finally:
        try: case.close(); report['cleanup_completed'] = True
        finally:
            path = Path(args.report); path.write_text(json.dumps(report, indent=2) + '\n'); path.chmod(0o600)
    print(json.dumps({'passed': True, 'provider': 'synthetic-managed-host-codex-deep-and-fast'}))


if __name__ == '__main__': main()
