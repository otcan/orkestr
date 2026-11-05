"""Actual managed resume over Core HTTP and private Root launch descriptors.

Only a disposable fixed synthetic native is used. Production gates, real native
sessions, accounts and service configurations are never changed.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from identity_split_service_http import Rehearsal, wait
from codex_bounded.trust import exists
from codex_service.ownership import Adopted


class ResumeRehearsal(Rehearsal):
    def start_rehearsal(self):
        original=Adopted._remember
        def remember(pool, identity):
            try:return original(pool,identity)
            except BaseException:
                self.unknown_adopted=dict(identity)
                try:self.unknown_adopted['executable']=str(Path('/proc',str(identity['pid']),'exe').resolve())
                except OSError:pass
                raise
        self.original_remember=original
        Adopted._remember=remember
        super().start_rehearsal()

    def close(self):
        try:super().close()
        finally:
            if hasattr(self,'original_remember'):Adopted._remember=self.original_remember

    def rows(self, query, args=()):
        with sqlite3.connect((self.package.data / 'core.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(query, args)]

    def claims(self):
        return [json.loads(p.read_text()) for p in (self.package.ledger_directory / 'launches').glob('*.json')]

    def run(self):
        report = super().run()
        first = self.rows("SELECT id,role,native_session_id FROM production_runs ORDER BY role")
        path = '/api/v2/conversations/' + self.conversation
        code, window = self.request(path + '/window')
        assert code == 200 and window['generation'] == 1, (code, window)
        # The supported operator drain retires accepted idle natively owned
        # processes and their window. No terminal/ownership SQL is modified.
        drain=self.package.data/'deploy-drain.request'
        drain.touch(mode=0o600);os.chown(drain,self.package.authority_uid,self.package.authority_gid)
        def retired():
            assert not self.pump_errors, self.pump_errors
            code,current=self.request(path+'/window')
            return code==200 and current['state']=='closed' and all(
                r['state']=='exited' for r in self.claims())
        wait(retired, 'accepted idle window drained and original brokers retired', seconds=20)
        drain.unlink()
        def resumed_admission():
            status=self.package.data/'deploy-drain.status.json'
            return status.exists() and json.loads(status.read_text())['draining'] is False
        wait(resumed_admission,'operator drain released',seconds=5)
        key = 'synthetic-split-second'
        code, receipt = self.request(path + '/messages', 'POST',
            {'client_message_id': key, 'text': 'synthetic ordinary HTTP input 2', 'author': 'owner'})
        assert code == 202, (code, receipt)
        code, admission = self.request(path + '/window', 'POST',
            {'request_key': 'window:' + key, 'input_message_id': receipt['message_id'],
             'input_event_id': receipt['event_id'], 'input_request_key': key,
             'expected_generation': 1, 'window_id': None,
             'predecessor_window_id': window['window_id']})
        assert code == 201, (code, admission)
        def completed():
            assert not self.pump_errors, self.pump_errors
            rows = self.rows("SELECT id,role,state,native_session_id FROM production_runs WHERE message_id=?",
                             (receipt['message_id'],))
            return rows if rows and any(r['role'] == 'deep' for r in rows) and all(
                r['state'] == 'succeeded' for r in rows) else None
        second = wait(completed, 'new input accepted after exact native resume', seconds=30)
        old = {r['role']: r for r in first}
        for row in second:
            assert row['id'] != old[row['role']]['id']
            assert row['native_session_id'] == old[row['role']]['native_session_id']
        def reaped():
            claims = self.claims()
            resumed = [r for r in claims if r['mode'] == 'resume']
            return resumed if resumed and all(r['state'] == 'exited' and not exists(
                {'pid': r['proxy_pid'], 'start': r['proxy_start'], 'uid': self.package.authority_uid})
                for r in resumed) else None
        resumed = wait(reaped, 'resumed original owned broker and proxy reaped', seconds=15)
        for record in resumed:
            role = record['setup']['role']
            assert record['setup']['native_session_id'] == old[role]['native_session_id']
        trace = (self.fixture.root / 'claude-workspace/claude-peer.jsonl' if self.provider == 'claude'
                 else self.fixture.account / 'sessions/synthetic-role.jsonl')
        events = [json.loads(line) for line in trace.read_text().splitlines()]
        assert any(r['resumed'] for r in events if r['kind'] in ('spawn', 'ready'))
        assert len(self.rows('SELECT id FROM messages')) == 2
        assert len(self.rows('SELECT id FROM production_runs')) == len(first) + len(second)
        report.update(resumed_runs=second, resumed_launch_count=len(resumed),
            same_native_identity=True, original_inputs_replayed=False,
            root_attested_metadata_and_private_fd4=True,
            source_authority_uid=self.package.authority_uid,
            resumed_executor_uid=self.package.executor_uid)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--provider', choices=('codex', 'claude'), default='codex')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0
    os.umask(0o077)
    case = ResumeRehearsal(args.binary, args.provider)
    report = {'passed': False, 'live_activation': False, 'actual_provider': False}
    try:
        report.update(case.run(), passed=True)
    except BaseException as error:
        report.update(error_type=type(error).__name__, error=str(error),
                      manager_errors=case.pump_errors, launch_claims=case.claims(),
                      unknown_adopted=getattr(case,'unknown_adopted',None))
        if (case.package.data / 'core.sqlite3').exists():
            report['runs'] = case.rows('SELECT id,role,state,native_session_id FROM production_runs')
        raise
    finally:
        try:
            case.close()
            report['cleanup_completed'] = True
        finally:
            path = Path(args.report)
            path.write_text(json.dumps(report, indent=2) + '\n')
            path.chmod(0o600)
    print(json.dumps({'passed': True, 'provider': args.provider, 'same_native_identity': True}))


if __name__ == '__main__':
    main()
