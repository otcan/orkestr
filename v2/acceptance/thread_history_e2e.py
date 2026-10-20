#!/usr/bin/env python3
"""End-to-end V1 thread <-> V2 conversation history move against a built server.

Synthetic data only: a throwaway V1 home and a fresh ORKESTR_V2_HOME. Covers
export (WAL included), dry-run, create+apply, idempotent re-import, delta
import, archived reads, native isolation, rollback export and inert V1 append.

    python3 -B acceptance/thread_history_e2e.py PATH/TO/orkestr-v2-server
"""
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib import request

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'migration' / 'thread_history.py'
sys.path.insert(0, str(ROOT / 'migration' / 'tests'))
sys.path.insert(0, str(ROOT / 'migration'))
from v1_fixture import V1Home  # noqa: E402
import v2_client  # noqa: E402


def port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def cli(*args, check=True):
    result = subprocess.run([sys.executable, '-I', '-B', str(CLI), *args], capture_output=True, text=True)
    assert 'synthetic e2e' not in result.stdout + result.stderr, 'message text leaked into a report'
    if check and result.returncode != 0:
        raise AssertionError(f'{args[0]} failed: {result.stderr.strip()}')
    return json.loads(result.stdout)['result'] if result.returncode == 0 else json.loads(result.stderr)


def wait(url, process):
    for _ in range(300):
        if process.poll() is not None:
            raise AssertionError('server exited during startup')
        try:
            with request.urlopen(url + '/api/v2/health', timeout=1):
                return
        except OSError:
            time.sleep(0.1)
    raise AssertionError('server did not become healthy')


def main(server):
    with tempfile.TemporaryDirectory(prefix='thread-history-e2e-') as temp:
        temp = Path(temp)
        bind = f'127.0.0.1:{port()}'
        url = f'http://{bind}'
        token = secrets.token_hex(32)
        env = {'PATH': '/usr/bin:/bin', 'ORKESTR_V2_HOME': str(temp / 'v2-home'),
               'ORKESTR_V2_BIND': bind, 'ORKESTR_V2_BOOTSTRAP_TOKEN': token}
        log = open(temp / 'server.log', 'wb')
        process = subprocess.Popen([server], env=env, stdout=log, stderr=subprocess.STDOUT)
        home = None
        try:
            wait(url, process)
            password = secrets.token_hex(16)
            setup = request.Request(url + '/api/v2/setup', method='POST', headers={
                'Content-Type': 'application/json', 'x-orkestr-bootstrap': token},
                data=json.dumps({'username': 'synthetic-owner', 'password': password}).encode())
            request.urlopen(setup, timeout=10).close()
            credentials = temp / 'credentials.json'
            credentials.write_text(json.dumps({'username': 'synthetic-owner', 'password': password}))
            os.chmod(credentials, 0o600)
            remote = ['--v2-url', url, '--credentials-file', str(credentials)]

            home = V1Home(temp / 'v1-home')
            home.thread('alpha')
            home.thread('noise')
            home.message('noise', 'user', 'synthetic e2e other thread')
            upload = home.upload('alpha', 'note.txt', b'synthetic e2e attachment')
            for index in range(1, 121):
                home.message('alpha', 'user' if index % 2 else 'assistant', f'synthetic e2e {index}',
                             phase='' if index % 2 else 'final_answer',
                             attachments=[{'name': 'note.txt', 'path': upload}] if index == 3 else None)
            export = cli('v1-export', '--v1-home', str(home.root), '--thread', 'alpha',
                         '--out', str(temp / 'bundle-1'), '--source-instance', 'synthetic-v1')
            assert export['threads'][0]['exported'] == 120, export

            plan = cli('v2-import', '--bundle', str(temp / 'bundle-1'), '--thread', 'alpha',
                       '--create-name', 'Imported alpha', *remote)
            assert plan['mode'] == 'dry_run' and plan['delta']['messages'] == 120, plan
            first = cli('v2-import', '--bundle', str(temp / 'bundle-1'), '--thread', 'alpha',
                        '--create-name', 'Imported alpha', '--apply', *remote)
            conversation = first['conversation_id']
            assert first['result']['inserted'] == 120 and first['verified'] == 'exact_match', first
            again = cli('v2-import', '--bundle', str(temp / 'bundle-1'), '--thread', 'alpha',
                        '--create-name', 'Imported alpha', '--apply', *remote)
            assert again['conversation_id'] == conversation and again['delta']['messages'] == 0, again
            assert again['target_after']['message_count'] == 120, again

            for index in range(121, 126):
                home.message('alpha', 'user', f'synthetic e2e {index}')
            cli('v1-export', '--v1-home', str(home.root), '--thread', 'alpha',
                '--out', str(temp / 'bundle-2'), '--source-instance', 'synthetic-v1')
            delta = cli('v2-import', '--bundle', str(temp / 'bundle-2'), '--thread', 'alpha',
                        '--conversation', conversation, '--apply', *remote)
            assert delta['delta']['messages'] == 5 and delta['result']['inserted'] == 5, delta
            assert delta['target_after']['message_count'] == 125 and delta['verified'] == 'exact_match', delta
            status = cli('v2-status', '--conversation', conversation, *remote)
            assert status['sources'][0]['cursor'] == 125, status

            client = v2_client.Client(url)
            client.login('synthetic-owner', password)
            try:
                entries, after = [], 0
                while True:
                    page = client.get(f'/api/v2/conversations/{conversation}/archived-history',
                                      {'after': after, 'limit': 100})
                    entries += page['entries']
                    if page['next_after'] is None:
                        break
                    after = page['next_after']
                positions = [e['message']['source_position'] for e in entries]
                assert positions == list(range(1, 126)), 'archived order'
                assert entries[1]['message']['role'] == 'assistant'
                assert entries[1]['message']['phase'] == 'final_answer'
                assert entries[2]['message']['attachments'][0]['available'] is True
                native = client.get(f'/api/v2/conversations/{conversation}', {'after': 0, 'limit': 100})
                assert native['messages'] == [], 'archived history must not become native input'
                for index in (1, 2):
                    client.post(f'/api/v2/conversations/{conversation}/messages',
                                {'client_message_id': f'e2e-native-{index}', 'text': f'synthetic e2e native {index}'})
            finally:
                client.close()

            archive = cli('v2-export', '--conversation', conversation, '--out', str(temp / 'rollback.json'), *remote)
            assert archive['entries'] == 2, archive
            database = str(home.root / 'thread-messages.sqlite')
            dry = cli('v1-append', '--archive', str(temp / 'rollback.json'), '--v1-db', database, '--thread', 'alpha')
            assert dry['mode'] == 'dry_run' and dry['appended'] == 0, dry
            applied = cli('v1-append', '--archive', str(temp / 'rollback.json'), '--v1-db', database,
                          '--thread', 'alpha', '--apply')
            assert applied['appended'] == 2 and applied['first_position'] == 126, applied
            repeat = cli('v1-append', '--archive', str(temp / 'rollback.json'), '--v1-db', database,
                         '--thread', 'alpha', '--apply')
            assert repeat['appended'] == 0 and repeat['already_present'] == 2, repeat
            check = sqlite3.connect(database)
            states = check.execute("select state,count(*) from orkestr_thread_messages where thread_id='alpha' "
                                   "and source='orkestr-v2-archive' group by state").fetchall()
            check.close()
            assert states == [('archived', 2)], states
            print(json.dumps({'ok': True, 'imported': 125, 'delta': 5, 'rollback_appended': 2}))
        finally:
            if home:
                home.close()
            process.terminate()
            process.wait(timeout=30)
            log.close()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
