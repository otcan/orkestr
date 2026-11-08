"""Default single-agent fresh/resumed windows with actual Core and Root custody.

Disposable synthetic providers only. Retains old launcher inventory and Claude's
old Fast setting, but never opts into legacy composition. Codex also exercises
two explicit Worker tasks through their original scoped lifecycle.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path

from identity_split_resume_http import ResumeRehearsal
from identity_split_host_http import HostRehearsal


class SingleAgentRehearsal(ResumeRehearsal):
    def __init__(self, binary, provider, managed_host=False):
        # The Worker fixture configures the full historical role inventory.
        # Its parent Deep owns explicit Worker tasks; they are not companions.
        super().__init__(binary, 'workers' if provider == 'codex' and not managed_host else provider)
        self.selected_provider = provider
        self.managed_host_case = managed_host
        if managed_host:
            # The same configured Worker inventory is retained. This case
            # exercises host-native lifecycle, not the bounded Worker sandbox.
            self.configure_roles()
            (self.fixture.workspace / 'mode').write_text('complete')
        path = self.package.root / 'beta.json'
        beta = json.loads(path.read_text())
        beta.pop('legacy_companions', None)
        path.write_text(json.dumps(beta))
        self.refresh_manifest()
        assert 'legacy_companions' not in self.package.beta

    def exercise_worker_reuse(self, path):
        completed = super().exercise_worker_reuse(path)
        # Only the first owner turn is held while its two Workers finish.
        # Later resumed turns must use the ordinary completion protocol;
        # release-1 cannot release the native's per-input holds for 2 and 3.
        (self.fixture.workspace / 'mode').write_text('complete')
        return completed

    def run(self):
        report = super().run()
        runs = self.rows('SELECT id,role,state,native_session_id FROM production_runs')
        claims = self.claims()
        assert runs and all(row['state'] == 'succeeded' for row in runs), runs
        assert not any(row['role'] == 'fast' for row in runs), runs
        assert not any(row['role'] == 'fast' for row in claims), claims
        deep = [row for row in runs if row['role'] == 'deep']
        assert len(deep) == 3 and len({row['native_session_id'] for row in deep}) == 1
        accepted = self.rows('SELECT a.run_id FROM production_acceptances a '
                             'JOIN production_runs r ON r.id=a.run_id WHERE r.role=\'deep\'')
        assert {row['run_id'] for row in accepted} == {row['id'] for row in deep}
        assert all(row['state'] == 'exited' for row in claims), claims
        if self.selected_provider == 'codex' and not self.managed_host_case:
            assert report['worker_reuse_count'] == 2, report
            assert len([row for row in runs if row['role'] == 'worker']) == 2
        elif self.selected_provider == 'claude':
            trace = self.fixture.root / 'claude-workspace/claude-peer.jsonl'
            events = [json.loads(line) for line in trace.read_text().splitlines()]
            assert not any(row.get('read_only') for row in events if row['kind'] == 'spawn')
        code, capabilities = self.request('/api/v2/conversations/' + self.conversation + '/intelligence')
        assert code == 200 and not capabilities['fast']['configured'], (code, capabilities)
        assert capabilities['worker']['configured'] == (self.selected_provider == 'codex')
        report.update(provider=self.selected_provider, single_agent_default=True,
                      fast_core_runs=0, fast_root_launches=0, accepted_owner_turns=3,
                      original_native_history_preserved=True, original_inputs_replayed=False,
                      bounded_workers_exercised=not self.managed_host_case and self.selected_provider == 'codex',
                      actual_provider=False, live_activation=False)
        return report


class ManagedSingleAgentRehearsal(SingleAgentRehearsal, HostRehearsal):
    """The existing host fixture for platforms without bounded namespaces."""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--provider', choices=('codex', 'claude'), required=True)
    parser.add_argument('--managed-host', action='store_true',
                        help='Codex host-native lifecycle only; no bounded Worker acceptance claim')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0, 'explicit disposable Root fixture only'
    os.umask(0o077)
    assert not args.managed_host or args.provider == 'codex'
    case_type = ManagedSingleAgentRehearsal if args.managed_host else SingleAgentRehearsal
    case = case_type(args.binary, args.provider, args.managed_host)
    report = {'passed': False, 'actual_provider': False, 'live_activation': False,
              'harness_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    try:
        report.update(case.run(), passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__, error=str(error),
                      manager_errors=case.pump_errors, launch_claims=case.claims())
        if case.process is not None:
            report['server_returncode'] = case.process.poll()
            if case.process.stderr is not None:
                os.set_blocking(case.process.stderr.fileno(), False)
                try:
                    report['synthetic_server_stderr'] = os.read(case.process.stderr.fileno(), 16384).decode(errors='replace')
                except BlockingIOError:
                    pass
        for name in ('memory.events', 'pids.events'):
            path = Path('/sys/fs/cgroup') / name
            if path.exists():
                report[name] = path.read_text()
        raise
    finally:
        try:
            case.close()
            report['cleanup_completed'] = True
        finally:
            path = Path(args.report)
            path.write_text(json.dumps(report, indent=2) + '\n')
            path.chmod(0o600)
    print(json.dumps({'passed': True, 'provider': args.provider, 'single_agent_default': True}))


if __name__ == '__main__':
    main()
