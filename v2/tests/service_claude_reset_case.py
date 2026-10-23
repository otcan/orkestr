"""Owner reset and successor resume through actual HTTP/root manager; no provider."""
from owned_execution_http import wait_for


def restart_manager(case):
    case.reset_restarts = getattr(case, 'reset_restarts', 0) + 1
    case.spawn([str(case.fixture.package / 'manager.py'), case.receipt['manifest_sha256']],
               {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
               label='manager-reset-' + str(case.reset_restarts))
    wait_for(lambda: case.listener(case.fixture.package / 'server'), 'restarted manager listener', 15)


def run(case, window, prior, *, turn, expect):
    prefix = '/api/v2/conversations/' + case.conversation
    reset = dict(request_key='synthetic-owner-native-reset', window_id=window['window_id'],
                 generation=window['generation'], acknowledge_native_history_loss=True)
    history = case.rows('SELECT id,text,sequence FROM messages ORDER BY sequence')
    runs = case.rows('SELECT id,state,native_session_id FROM production_runs ORDER BY rowid')
    old_ids = {r['native_session_id'] for r in runs}
    expect(case, prefix + '/window/reset-native', 400, 'POST',
           dict(reset, acknowledge_native_history_loss=False))
    receipt = expect(case, prefix + '/window/reset-native', 200, 'POST', reset)
    assert expect(case, prefix + '/window/reset-native', 200, 'POST', reset) == receipt
    assert history == case.rows('SELECT id,text,sequence FROM messages ORDER BY sequence')
    assert runs == case.rows('SELECT id,state,native_session_id FROM production_runs ORDER BY rowid')
    assert len(case.rows('SELECT id FROM conversation_native_resets')) == 1
    assert not case.rows("SELECT id FROM session_bindings WHERE state!='retired'")
    settings = expect(case, prefix + '/settings')
    assert settings['provider'] == 'claude' and settings['provider_generation'] == 1
    third, first, text = turn(case, 'reset:1', 'synthetic new input after explicit reset', None,
        window['generation'], prior['run_id'], predecessor=window['window_id'])
    assert text == 'synthetic Claude turn 1', text
    _, second, text = turn(case, 'reset:2', 'synthetic followup after reset', third['window_id'],
        third['generation'], first['run_id'])
    assert text == 'synthetic Claude turn 2', text
    case.stop()
    restart_manager(case)
    fourth, _, text = turn(case, 'reset:3', 'synthetic successor after reset', None,
        third['generation'], second['run_id'], predecessor=third['window_id'])
    assert text == 'synthetic Claude turn 3', text
    new_runs = case.rows('SELECT id,role,provider_kind,native_session_id,state FROM production_runs ORDER BY rowid')[len(runs):]
    assert len(new_runs) == 6 and {r['state'] for r in new_runs} == {'succeeded'}
    assert {r['provider_kind'] for r in new_runs} == {'claude'}
    assert old_ids.isdisjoint({r['native_session_id'] for r in new_runs})
    assert {r['state'] for r in case.rows('SELECT state FROM session_bindings WHERE native_session_id IN (' +
        ','.join('?' for _ in old_ids) + ')', tuple(old_ids))} == {'retired'}
    for role in ('fast', 'deep'):
        assert len({r['native_session_id'] for r in new_runs if r['role'] == role}) == 1
    assert fourth['generation'] == window['generation'] + 2
    case.stop()
    return {'receipt': receipt, 'new_runs': new_runs, 'successor_generation': fourth['generation']}
