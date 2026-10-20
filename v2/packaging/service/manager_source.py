"""Load the authoritative inventory only from an exact reviewed Git tree."""
from contextlib import contextmanager
import importlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from closure import require

# Qualified persistent Deep beta baseline, including its reviewed retirement
# and paused-launch corrections. The original worker revision is not an
# ancestor of the integration branch; require the qualified successor instead.
MANAGER_BASE = 'f6fb00a461d792af22ec15c80d089c266081ca3b'


def git(repository, *arguments):
    return subprocess.run(['/usr/bin/git','-c','safe.directory='+str(repository),'-C',str(repository),*arguments],
        check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,
        env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null',
             'GIT_NO_REPLACE_OBJECTS':'1'}).stdout


@contextmanager
def authority(repository, commit):
    require(re.fullmatch('[0-9a-f]{40}',commit),'exact source required')
    git(repository,'merge-base','--is-ancestor',MANAGER_BASE,commit)
    require(not any(n in sys.modules for n in ('codex_service','codex_bounded')), 'fresh isolated packager process required')
    with tempfile.TemporaryDirectory(prefix='service-source-',dir=Path.home()) as scratch:
        root=Path(scratch);total=0
        listing=git(repository,'ls-tree','-rz',commit+':v2/provider-broker')
        for row in listing.split(b'\0'):
            if not row:continue
            header,name=row.split(b'\t',1);mode,kind,oid=header.split()
            name=name.decode('utf-8')
            if not name.endswith('.py'):continue
            require(mode in (b'100644',b'100755') and kind==b'blob' and
                    all(p not in ('','..','.') for p in name.split('/')),'regular Git source required')
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
