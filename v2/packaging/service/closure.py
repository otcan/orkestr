"""Linux x86_64 startup file inventory; never execute supplied ELF artifacts."""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import sysconfig


def require(value, message):
    if not value:raise RuntimeError(message)


def pin(path):
    path=Path(path).resolve(strict=True);s=path.stat()
    require(stat.S_ISREG(s.st_mode),'regular dependency required')
    return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'bytes':s.st_size,'uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode)}


def trusted(path):
    path=Path(path).resolve(strict=True)
    for item in (path,*path.parents):
        s=item.stat();require(s.st_uid==0 and not s.st_mode&0o022,'root-owned nonwritable runtime required')
    return path


def elf_files(binary):
    """Resolve literal DT_NEEDED entries through fixed trusted system roots only."""
    tool=trusted('/usr/bin/readelf');roots=[Path('/lib/x86_64-linux-gnu'),Path('/usr/lib/x86_64-linux-gnu')]
    pending=[Path(binary).resolve()];seen={};tool_pin=pin(tool)
    while pending:
        path=pending.pop()
        if str(path) in seen:continue
        data=path.read_bytes()[:20]
        require(data[:6]==b'\x7fELF\x02\x01' and data[18:20]==b'\x3e\x00','Linux x86_64 ELF required')
        text=subprocess.run([str(tool),'-lWd',str(path)],check=True,capture_output=True,text=True,
                            env={'PATH':'/usr/bin:/bin','LANG':'C'}).stdout
        require(not re.search(r'\((?:RPATH|RUNPATH)\)',text),'custom ELF library search paths unsupported')
        seen[str(path)]=pin(path)
        interpreter=re.findall(r'Requesting program interpreter: ([^\]]+)',text)
        for name in re.findall(r'\(NEEDED\).*\[([^\]]+)\]',text):
            require('/' not in name,'literal library basename required')
            matches={str((root/name).resolve()) for root in roots if (root/name).is_file()}
            require(len(matches)==1,'missing or ambiguous system library: '+name)
            pending.append(trusted(matches.pop()))
        pending.extend(trusted(name) for name in interpreter)
    return {'readelf':tool_pin,'files':seen}


def python_files():
    require(sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode,'use -I -S -B')
    files={}
    for path in sorted(Path(sysconfig.get_path('stdlib')).rglob('*')):
        if path.is_file():
            p=trusted(path);files[str(p)]=pin(p)
    files[str(Path(sys.executable).resolve())]=pin(trusted(sys.executable))
    native={}
    for line in Path('/proc/self/maps').read_text().splitlines():
        fields=line.split(maxsplit=5)
        if len(fields)==6 and fields[5].startswith('/'):
            p=trusted(fields[5]);native[str(p)]=pin(p)
    return {'executable':str(Path(sys.executable).resolve()),'files':files,'native':native,
            'flags':['-I','-S','-B'],'limits':['future dlopen/provider plugins unsupported; not a whole-host attestation']}


def verify(value):
    for entry in value:
        require(pin(entry['path'])==entry,'startup dependency changed')
