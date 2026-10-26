"""Independent two-scope ordinary HTTP task/auth isolation gate; synthetic peers only."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import traceback
import uuid

from owned_execution_group import GroupCase, stop_request
from owned_execution_http import Case, wait_for
from worker_tasks_http import INSTRUCTIONS


class TwoScope(GroupCase):
    def configure(self):
        super().configure()
        shutil.copyfile(Path(__file__).with_name('worker_task_peer.py'), self.root / 'synthetic-provider')
        (self.root / 'synthetic-provider').chmod(0o700)
        for file, workspace in zip(['execution.json', 'second-execution.json'], self.workspaces):
            path = self.root / file
            config = json.loads(path.read_text())
            config['worker'] = {'mode': 'owner-tasks-v1', 'lifetime_ms': 30000}
            path.write_text(json.dumps(config))
            (workspace / 'expected-tasks.json').write_text(json.dumps(INSTRUCTIONS))
            (workspace / 'hold-deep').touch()
            (workspace / 'hold-worker').touch()


def exercise(case, checks):
    parents = case.both_running()
    def check(name, actual, expected):
        checks.append({'name': name, 'actual': actual, 'expected': expected})
        assert actual == expected, checks[-1]
    def listing(index):
        code, body, _ = case.request(case.paths[index] + '/worker-tasks?parent_run_id=' + parents[index]['run_id'])
        assert code == 200
        return body
    def exact(index, run):
        code, body, _ = case.request(case.paths[index] + '/execution?run_id=' + run)
        assert code == 200
        return body
    bodies, receipts, children = [], [], []
    for index in range(2):
        wait_for(lambda: listing(index)['can_create'], 'owned task scheduler')
        parent = exact(index, parents[index]['run_id'])
        body = {'parent_run_id': parent['run_id'], 'expected_control_revision': parent['control_revision'],
                'request_key': 'synthetic:scope-task', 'title': 'Synthetic alpha',
                'instructions': INSTRUCTIONS['alpha'], 'lifetime_ms': 30000}
        code, receipt, _ = case.request(case.paths[index] + '/worker-tasks', 'POST', body)
        check(f'{index}:create', code, 200)
        check(f'{index}:replay', case.request(case.paths[index] + '/worker-tasks', 'POST', body)[:2], (200, receipt))
        child = wait_for(lambda: next((row for row in listing(index)['tasks'] if row['task']['task_id'] == receipt['task_id'] and row['phase'] == 'running'), None), 'scoped Worker running')
        bodies.append(body); receipts.append(receipt); children.append(child)
    initial = [listing(i) for i in range(2)]
    for i in range(2):
        base = case.paths[i] + '/worker-tasks'
        other = 1-i
        check(f'{i}:foreign-parent-list', case.request(base + '?parent_run_id=' + parents[other]['run_id'])[0], 404)
        check(f'{i}:foreign-parent-create', case.request(base, 'POST', bodies[other])[0], 404)
        check(f'{i}:foreign-run-read', case.request(case.paths[i] + '/execution?run_id=' + children[other]['run_id'])[0], 404)
        check(f'{i}:foreign-run-stop', case.request(case.paths[i] + '/stop', 'POST', stop_request(exact(other, children[other]['run_id']), 'cross-stop'))[0], 503)
        for suffix, method, body in [('/hold', 'POST', {}), ('/payload', 'DELETE', None)]:
            check(f'{i}:foreign-task{suffix}', case.request(base + '/' + receipts[other]['task_id'] + suffix, method, body)[0], 404)
        for name, browser, headers, status in [('anonymous', False, {}, 401), ('csrf', True, {'x-orkestr-csrf':'wrong'},403), ('origin',True,{'Origin':'https://invalid.example'},403), ('cookie',True,{'Cookie':'invalid=synthetic'},401)]:
            check(f'{i}:{name}', case.request(base, 'POST', bodies[i], browser, headers)[0], status)
        own_task = base + '/' + receipts[i]['task_id']
        for suffix, method, data in [('/hold','POST',{}),('/payload','DELETE',None)]:
            for label, browser, headers, expected in [('anonymous',False,{},401),('csrf',True,{'x-orkestr-csrf':'wrong'},403),('origin',True,{'Origin':'https://invalid.example'},403)]:
                check(f'{i}:{suffix}:{label}',case.request(own_task+suffix,method,data,browser,headers)[0],expected)
        check(f'{i}:delegated-hold-refused',case.request(own_task+'/hold','POST',{})[0],409)
        check(f'{i}:changed-retry', case.request(base, 'POST', dict(bodies[i], instructions='changed synthetic task'))[0],409)
    foreign = Case()
    try:
        foreign.setup()
        for i in range(2):
            check(f'{i}:foreign-installation-cookie', case.request(case.paths[i] + '/worker-tasks?parent_run_id=' + parents[i]['run_id'], extra={'Cookie':foreign.cookie,'x-orkestr-csrf':foreign.csrf})[0],401)
    finally:
        foreign.cleanup()
    code, project, _ = case.request('/api/v2/projects','POST',{'client_request_id':'unconfigured','name':'Synthetic unconfigured'})
    assert code == 201
    for name, conv, expected in [('unconfigured',project['conversation_id'],503),('unknown',str(uuid.uuid4()),404)]:
        base = '/api/v2/conversations/' + conv + '/worker-tasks'
        check(name+':list',case.request(base+'?parent_run_id='+parents[0]['run_id'])[0],expected)
        check(name+':create',case.request(base,'POST',bodies[0])[0],expected)
    for i in range(2):
        check(f'{i}:tasks-unchanged',listing(i),initial[i])
        check(f'{i}:parent-running',exact(i,parents[i]['run_id'])['phase'],'running')
        rows = case.trace_for(i)
        check(f'{i}:native-turns',sum(row['kind']=='turn' for row in rows),2)
        check(f'{i}:no-interrupt',sum(row['kind']=='interrupt' for row in rows),0)
        worker = [row for row in rows if row['kind']=='turn' and row.get('role')=='worker']
        check(f'{i}:exact-instructions',[row['instructions'] for row in worker],[INSTRUCTIONS['alpha']])
    for i in range(2):
        status = wait_for(lambda: (s if (s:=exact(i,children[i]['run_id']))['capabilities']['stop'] else None), 'Worker Stop capability')
        body = stop_request(status, 'scope-worker-stop')
        code, receipt, _ = case.request(case.paths[i]+'/stop','POST',body)
        check(f'{i}:worker-stop',code,200)
        wait_for(lambda: exact(i,children[i]['run_id'])['phase']=='cancelled','Worker terminal')
        check(f'{i}:stop-replay',case.request(case.paths[i]+'/stop','POST',body)[:2],(200,receipt))
        check(f'{i}:parent-survives',exact(i,parents[i]['run_id'])['phase'],'running')
        if i == 0:
            check('sibling-worker-survives',exact(1,children[1]['run_id'])['phase'],'running')
            check('sibling-no-interrupt',sum(row['kind']=='interrupt' for row in case.trace_for(1)),0)
    for i in range(2):
        payload = case.paths[i]+'/worker-tasks/'+receipts[i]['task_id']+'/payload'
        check(f'{i}:same-scope-delete',case.request(payload,'DELETE')[0],204)
        check(f'{i}:delete-replay',case.request(payload,'DELETE')[0],204)
        task = listing(i)['tasks'][0]
        check(f'{i}:tombstone',[task['title'],task['instructions_available']],[None,False])
    for i in range(2):
        check(f'{i}:final-native-turns',sum(row['kind']=='turn' for row in case.trace_for(i)),2)


def main():
    output = Path(sys.argv[2]); output.mkdir(parents=True, exist_ok=False)
    receipt = {'source_commit':'25b3bbb463bd1e71f7c9f2f8eb72e43348b64b4d',
               'server_sha256':hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest(),
               'harness_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'dependencies':{str(p.relative_to(Path(__file__).parent.parent)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path(__file__).parent.glob('*.py')) if p.name != Path(__file__).name}, 'checks':[], 'passed':False}
    assert receipt['server_sha256']=='5d7ffdbff1a98311bb54163067a5c517ee334c1e58faf7297cf1bb0168505edf'
    case = TwoScope()
    try:
        case.setup(); exercise(case,receipt['checks']); receipt['passed']=True
    except Exception:
        receipt['failure']=traceback.format_exc()
        raise
    finally:
        case.cleanup()
        receipt['cleanup']={'server_gone':case.process is None or case.process.poll() is not None,
                            'native_gone':case.peer_gone(),'temporary_state_removed':not case.root.exists()}
        (output/'receipt.json').write_text(json.dumps(receipt,indent=2))

if __name__=='__main__': main()
