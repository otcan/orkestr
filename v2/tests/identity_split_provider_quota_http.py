"""Synthetic quota bridge through the managed split-identity server package.

Disposable fixture only: no provider login, owner message or native model turn.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading

from identity_split_service_http import Rehearsal, Package, GID


class QuotaRehearsal(Rehearsal):
    def run(self):
        self.initialize_core()
        requests = []
        class Broker(BaseHTTPRequestHandler):
            def do_GET(handler):
                requests.append((handler.path, handler.headers.get('Authorization')))
                body = json.dumps({'quota': {
                    'codex': {'fiveHourRemainingPct': 42, 'weeklyRemainingPct': 19,
                              'account_ref': 'synthetic-private-account'},
                    'claude': {'weeklyRemainingPct': 0, 'stale': True}}}).encode()
                handler.send_response(200)
                handler.send_header('Content-Type', 'application/json')
                handler.send_header('Content-Length', str(len(body)))
                handler.end_headers()
                handler.wfile.write(body)
            def log_message(self, *args):
                pass
        bridge = ThreadingHTTPServer(('127.0.0.1', 0), Broker)
        worker = threading.Thread(target=bridge.serve_forever, daemon=True)
        worker.start()
        try:
            config = self.fixture.root / 'provider-quota.json'
            config.write_text(json.dumps({
                'v1_url': f'http://127.0.0.1:{bridge.server_port}',
                'bearer_token': 'synthetic-quota-bearer-token',
                'owner_id': self.owner, 'legacy_owner_id': 'synthetic-legacy-owner'}))
            os.chown(config, self.package.authority_uid, GID)
            config.chmod(0o600)
            service = self.package.root / 'service.json'
            runtime = json.loads(service.read_text())
            runtime['provider_quota'] = str(config)
            service.write_text(json.dumps(runtime))
            self.refresh_manifest()
            self.package = Package(self.package.root, self.manifest)
            assert self.package.environment()['ORKESTR_V2_PROVIDER_QUOTA_CONFIG'] == str(config)
            assert not self.package.beta.get('legacy_companions', False)
            self.start_rehearsal()
            # Machine tokens cannot read the owner-bound browser projection.
            browser_headers, self.browser_headers = self.browser_headers, {}
            assert self.request('/api/v2/provider-quotas',
                                headers={'Authorization': 'Bearer ' + self.token})[0] == 401
            self.browser_headers = browser_headers
            assert requests == []
            code, result = self.request('/api/v2/provider-quotas', headers=self.browser_headers)
            assert code == 200, (code, result)
            assert result['quota']['codex']['fiveHourRemainingPct'] == 42
            assert result['quota']['claude']['weeklyRemainingPct'] == 0
            assert result['quota']['claude']['stale'] is True
            assert 'synthetic-private-account' not in json.dumps(result)
            assert requests == [('/api/quota/providers?ownerUserId=synthetic-legacy-owner',
                                 'Bearer synthetic-quota-bearer-token')]
            assert self.request('/api/v2/provider-quotas?ownerUserId=foreign',
                                headers=self.browser_headers)[0] == 400
            assert len(requests) == 1
            assert not self.pump_errors, self.pump_errors
            assert list((self.package.ledger_directory / 'launches').glob('*.json')) == []
            return {'passed': True, 'managed_server_child': True, 'browser_owner_projection': True,
                    'untrusted_owner_refused': True, 'machine_token_refused': True,
                    'native_launches': 0, 'actual_provider': False, 'live_activation': False}
        finally:
            bridge.shutdown()
            worker.join(timeout=3)
            bridge.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0, 'disposable root-only fixture'
    os.umask(0o077)
    case = QuotaRehearsal(args.binary)
    report = {'passed': False, 'actual_provider': False, 'live_activation': False}
    try:
        report.update(case.run())
    except BaseException as error:
        report.update(error_type=type(error).__name__, error=str(error), manager_errors=case.pump_errors)
        if case.process and case.process.stderr:
            os.set_blocking(case.process.stderr.fileno(), False)
            try: report['stderr'] = os.read(case.process.stderr.fileno(), 16384).decode(errors='replace')
            except BlockingIOError: pass
        raise
    finally:
        try:
            case.close()
            report['cleanup_completed'] = True
        finally:
            Path(args.report).write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
