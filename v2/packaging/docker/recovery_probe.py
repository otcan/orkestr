"""Owned stopped-container recovery checkpoint; no builds, providers or host mounts.

Import exercise after stopping the unique project server. Configure probe.DOCKER
for the authorized host command path. The caller owns project/image teardown.
"""
import json
import re
from pathlib import Path
import probe


def exercise(context, container_id):
    context = Path(context)
    manifest = json.loads((context / 'artifact-manifest.json').read_text())
    project = manifest['project']
    if not re.fullmatch(r'v2-install-[0-9a-f]{12}', project):
        raise RuntimeError('owned project required')
    image = project + ':local'
    target_volume = project + '-restore'
    info = json.loads(probe.run('inspect', container_id))[0]
    if info['Config']['Labels'].get('com.docker.compose.project') != project:
        raise RuntimeError('stopped source must belong to owned project')
    if info['State']['Running'] or info['State'].get('Restarting'):
        raise RuntimeError('source container must be stopped before recovery')
    if probe.run('image', 'inspect', image, '--format', '{{.Id}}') != info['Image']:
        raise RuntimeError('same exact owned image required')
    if probe.run('volume', 'ls', '--filter', 'name=^' + target_volume + '$', '--quiet'):
        raise RuntimeError('fresh restore volume required; existing volume preserved')
    mounted = [m for m in info['Mounts'] if m['Destination'] == '/state']
    if len(mounted) != 1 or mounted[0].get('Name') != project + '-state' or mounted[0]['Type'] != 'volume':
        raise RuntimeError('explicit owned source volume required')
    base = ('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--user', '10001:10001',
            '--pids-limit', '64', '--entrypoint', 'python3')
    def helper(name, mounts, code):
        return probe.run(*base, '--name', project + '-' + name, *mounts, image, '-B', '-c',
                         "import sys;sys.path.insert(0,'/opt/v2');from pathlib import Path;import dormant,json,sqlite3;" + code)
    source = ['--mount', 'type=volume,src=' + project + '-state,dst=/state']
    snapshot = helper('backup', source,
                      "p=Path('/state/recovery-snapshot');h=dormant.snapshot(Path('/state/data/core.sqlite3'),p,Path('/opt/v2/artifact-manifest.json'));"
                      "db=sqlite3.connect((p/'core.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True);"
                      "print(json.dumps({'sha256':h,'messages':db.execute('SELECT count(*) FROM messages').fetchone()[0]}));db.close()")
    probe.run('volume', 'create', '--label', 'com.docker.compose.project=' + project, target_volume)
    try:
        mounts = ['--mount', 'type=volume,src=' + project + '-state,dst=/source,readonly',
                  '--mount', 'type=volume,src=' + target_volume + ',dst=/state']
        applied = helper('restore', mounts,
                         "dormant.apply(Path('/source/recovery-snapshot'),Path('/state'),Path('/opt/v2/artifact-manifest.json'));"
                         "db=sqlite3.connect('file:/state/data/core.sqlite3?mode=ro&immutable=1',uri=True);"
                         "print(json.dumps({'sha256':dormant.digest(Path('/state/data/core.sqlite3')),'messages':db.execute('SELECT count(*) FROM messages').fetchone()[0]}));db.close()")
        if json.loads(snapshot) != json.loads(applied):
            raise RuntimeError('actual snapshot/applied history or hash mismatch')
        refusal = helper('dormancy', mounts,
                         "import entrypoint; m=json.loads(Path('/opt/v2/artifact-manifest.json').read_text());\n"
                         "try: entrypoint.environment(Path('/opt/v2'),Path('/state'),{'ORKESTR_V2_ORIGIN':m['origin'],'ORKESTR_V2_CONTAINER_BIND':'1'})\n"
                         "except RuntimeError as e:\n assert 'dormant' in str(e);print('activation refused')\n"
                         "else: raise RuntimeError('activation was not refused')")
        rolled_back = helper('rollback', mounts,
                             "dormant.rollback(Path('/state'),Path('/opt/v2/artifact-manifest.json'));"
                             "assert not list(Path('/state').iterdir());print('empty target restored')")
        return {'status': 'passed', 'snapshot_and_applied': json.loads(applied),
                'activation': refusal, 'rollback': rolled_back,
                'scope': 'same exact image offline recovery; no cross-version migration'}
    finally:
        probe.run('volume', 'rm', target_volume)
