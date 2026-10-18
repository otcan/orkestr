"""Explicit owned binary version-query check; never starts a service or uses credentials."""
import json
import os
from pathlib import Path
import subprocess
import stat
import tempfile
import receipt


def inventory_bytes(root):
    result={}
    for path in root.rglob('*'):
        mode=path.lstat().st_mode
        receipt.require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), 'version query created special state')
        receipt.require(path.stat().st_size <= 1024*1024, 'version query created oversized state')
        info=path.lstat()
        result[path.relative_to(root).as_posix()] = (mode, info.st_uid, info.st_gid,
                                                    'directory' if stat.S_ISDIR(mode) else path.read_bytes())
    return result


def check(binary, expected, parent):
    """Call only after candidate integrity/embedded identity verification."""
    binary = binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='v2-version-',dir=parent) as temporary:
        root=Path(temporary)
        untouched=root/'existing';untouched.mkdir(mode=0o700)
        (untouched/'sentinel').write_bytes(b'synthetic untouched state')
        missing=root/'absent'
        env={'PATH':os.defpath,'LANG':'C','HOME':str(root/'absent-home')}
        checks=[]
        for name,home in [('no-config',None),('absent-home',missing),('existing-home',untouched)]:
            current=dict(env)
            if home is not None:
                current['ORKESTR_V2_HOME']=str(home)
            before=inventory_bytes(root)
            result=subprocess.run([str(binary),'--version','--json'],env=current,cwd=root,
                                  capture_output=True,text=True,timeout=5,check=False)
            receipt.require(result.returncode==0,'version query failed before configuration')
            value=json.loads(result.stdout)
            receipt.require(all(value.get(k)==v for k,v in expected.items()) and 'error' not in value,
                            'version query differs from embedded identity')
            receipt.require(inventory_bytes(root)==before,'version query mutated owned state')
            checks.append(name)
        return {'status':'passed','checks':checks,'identity':expected,
                'scope':'version queries only; no server/bootstrap/config initialization'}
