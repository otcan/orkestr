"""Isolated fixture Python closure capture and explicit package launcher argv."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import time
import urllib.error

BOOTSTRAP = ("import sys,runpy;tools=sys.argv.pop(1);entry=sys.argv.pop(1);"
             "sys.path.insert(0,tools);sys.argv[0]=entry;runpy.run_path(entry,run_name='__main__')")
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_inventory():
    if not (sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode):
        raise RuntimeError('required Python flags: -I -S -B')
    if dict(os.environ) != ENV:
        raise RuntimeError('exact sanitized environment required')
    stdlib=Path(sysconfig.get_path('stdlib')).resolve()
    helper=Path(__file__).resolve().parents[2]
    modules={}
    for name,module in sorted(sys.modules.items()):
        filename=getattr(module,'__file__',None)
        if not filename or filename.startswith('<'):
            continue
        path=Path(filename).resolve()
        if not (path.is_relative_to(stdlib) or path.is_relative_to(helper)):
            raise RuntimeError('module outside trusted helper/stdlib roots: '+name)
        modules[name]={'path':str(path),'sha256':sha(path)}
    # Pin source, cache and extension bytes, not merely sys.modules.__file__.
    files={}
    for path in sorted(stdlib.rglob('*')):
        if path.is_file():files[str(path)]={'resolved':str(path.resolve()),'sha256':sha(path)}
    executable=Path(sys.executable).resolve()
    libraries={}
    for line in Path('/proc/self/maps').read_text().splitlines():
        parts=line.split(maxsplit=5)
        if len(parts)==6 and parts[5].startswith('/'):
            path=Path(parts[5])
            if not path.is_file():raise RuntimeError('mapped native file unavailable')
            libraries[str(path.resolve())]=sha(path)
    return {'format':'orkestr-isolated-python-runtime-v1','executable':str(executable),
            'executable_sha256':sha(executable),'version':sys.version,
            'flags':['-I','-S','-B'],'sys_path':sys.path,'environment':dict(os.environ),
            'stdlib':str(stdlib),'stdlib_files':files,'imported_modules':modules,
            'loaded_native_files':libraries,
            'absent_startup_paths':[p for p in sys.path if not Path(p).exists()],
            'limitations':['module inventory is import-only; later lazy imports use sealed stdlib/helper bytes',
                          'loaded native dependencies only; not a whole-host ELF/runtime attestation']}


def verify_runtime(path):
    expected=json.loads(path.read_text())
    actual=runtime_inventory()
    for key in ('format','executable','executable_sha256','version','flags','sys_path',
                'environment','stdlib','stdlib_files','imported_modules','loaded_native_files','absent_startup_paths'):
        if actual[key]!=expected[key]:
            raise RuntimeError('Python import/runtime closure changed: '+key)


def argv(entry, *arguments):
    tools=Path(entry).resolve().parents[1]/'tools'
    return [sys.executable,'-I','-S','-B','-c',BOOTSTRAP,str(tools),str(tools/'launcher.py'),*map(str,arguments)]


def invoke(entry, command, home, *extra, expected=0):
    result=subprocess.run(argv(entry,command,'--home',home,*extra),env=ENV,
                          capture_output=True,text=True,timeout=40)
    if result.returncode!=expected:
        raise RuntimeError(command+' exit mismatch; private diagnostic withheld')
    return result


def launch(entry, home, client, log):
    process=subprocess.Popen(argv(entry,'start','--home',home),env=ENV,
                             stdout=log,stderr=log,start_new_session=True)
    try:
        for _ in range(150):
            if process.poll() is not None:raise RuntimeError('isolated launcher exited before readiness')
            try:
                client.health();return process
            except (urllib.error.URLError,ConnectionError,TimeoutError):time.sleep(0.1)
        raise RuntimeError('isolated launcher health deadline exceeded')
    except BaseException:
        from real_package import stop_owned
        stop_owned(process)
        raise
