"""Load the authoritative inventory only from an exact reviewed Git tree."""
from contextlib import contextmanager
import importlib
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from closure import require

MANAGER_BASE = '4ae4982c320377b3f496a5d657d9f4b985ba2e9b'


def git(repository, *arguments):
    return subprocess.run(['/usr/bin/git','-c','safe.directory='+str(repository),'-C',str(repository),*arguments],
        check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,
        env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null',
             'GIT_NO_REPLACE_OBJECTS':'1'}).stdout


# Reviewed test-only helpers at provider-broker root, not production modules.
TEST_HELPERS = {'bounded_proxy_fixture.py', 'codex_service_fixture.py',
                'selected_codex_fixture.py'}


def test_entrypoints(repository):
    """Only reviewed root test entrypoints; candidate-added test names are refused."""
    names=git(repository,'ls-tree','-r','--name-only',MANAGER_BASE+':v2/provider-broker').decode().splitlines()
    return TEST_HELPERS | {name for name in names
                           if '/' not in name and name.startswith('test_') and name.endswith('.py')}


def production_inventory(repository, commit):
    require(re.fullmatch('[0-9a-f]{40}',commit),'exact source required')
    result={};excluded=test_entrypoints(repository)
    for row in git(repository,'ls-tree','-rz',commit+':v2/provider-broker').split(b'\0'):
        if not row:continue
        header,name=row.split(b'\t',1);mode,kind,oid=header.split()
        name=name.decode('utf-8');parts=name.split('/')
        if not name.endswith('.py'):continue
        require(all(p not in ('','..','.') for p in parts),'safe Git path required')
        if name in excluded:continue
        require(mode in (b'100644',b'100755') and kind==b'blob','regular Git source required')
        result[name]=(mode,oid)
    require(result,'production Python required')
    return result


def verified_inventory(repository, commit):
    reviewed=production_inventory(repository,MANAGER_BASE)
    candidate=production_inventory(repository,commit)
    require(candidate==reviewed,'reviewed production Python inventory mismatch')
    return candidate


@contextmanager
def authority(repository, commit):
    # Cherry-picks preserve reviewed bytes without preserving commit ancestry.
    # Compare every production Python blob/mode before export or candidate import.
    inventory=verified_inventory(repository,commit)
    require(not any(n in sys.modules for n in ('codex_service','codex_bounded')), 'fresh isolated packager process required')
    with tempfile.TemporaryDirectory(prefix='service-source-',dir=Path.home()) as scratch:
        root=Path(scratch);total=0
        for name,(_,oid) in inventory.items():
            blob=git(repository,'cat-file','blob',oid.decode());total+=len(blob)
            require(total<=16*1024*1024,'source closure bound')
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(blob)
        sys.path.insert(0,str(root))
        try:
            module=importlib.import_module('codex_service.package')
            config=importlib.import_module('codex_bounded.configuration')
            yield root,module,config
        finally:
            sys.path.remove(str(root))
            for name,module in list(sys.modules.items()):
                location=getattr(module,'__file__',None)
                if location and Path(location).is_relative_to(root):sys.modules.pop(name,None)
