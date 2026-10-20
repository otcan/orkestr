"""Metadata-only credential/artifact separation before any artifact reads.

Requires a stable trusted operator namespace. This preflight does not defeat
hostile namespace replacement after its final metadata check.
"""
import os
from pathlib import Path
import stat
from closure import require


def canonical(path, directory=False):
    path=Path(path)
    require(path.is_absolute() and path.resolve(strict=True)==path,'canonical input required')
    info=path.lstat()
    require(not stat.S_ISLNK(info.st_mode) and
            (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)),
            'regular input required')
    if not directory:require(info.st_nlink==1,'input hardlink refused')
    return path,(info.st_dev,info.st_ino)


def separate(plan):
    credentials=[canonical(plan[key]) for key in ('auth_file','bootstrap_file')]
    identities={identity for _,identity in credentials}
    require(len(identities)==2,'credential alias refused')
    # Check every top-level input before walking UI or reading any bytes.
    artifacts=[canonical(plan[key]) for key in ('pair','server','native','code_mode_host') if key in plan]
    ui,_=canonical(plan['ui'],True)
    for secret,_ in credentials:
        require(secret!=ui and ui not in secret.parents,'credential inside UI refused')
    for _,identity in artifacts:require(identity not in identities,'credential artifact alias refused')
    for base,dirs,files in os.walk(ui,followlinks=False):
        for name in dirs:canonical(Path(base)/name,True)
        for name in files:
            _,identity=canonical(Path(base)/name)
            require(identity not in identities,'credential UI alias refused')
