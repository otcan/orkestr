#!/usr/bin/env python3
"""Deterministic gzip/tar envelope for an already verified credential-free candidate."""
import argparse
import gzip
import io
import tarfile
from pathlib import Path
import package_candidate
import receipt
from install_state import fresh_path


def archive(root, output):
    package_candidate.verify(root)
    output=fresh_path(output,[root])
    with open(output,'xb') as raw:
        with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed:
            with tarfile.open(fileobj=compressed,mode='w') as tar:
                for path in sorted(root.rglob('*')):
                    receipt.require(not path.is_symlink(),'archive symlink refused')
                    info=tarfile.TarInfo('candidate/'+path.relative_to(root).as_posix())
                    info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0
                    if path.is_dir():
                        info.type=tarfile.DIRTYPE;info.mode=0o755;tar.addfile(info)
                    else:
                        content=path.read_bytes();info.size=len(content)
                        info.mode=0o755 if path.stat().st_mode & 0o111 else 0o644
                        tar.addfile(info,io.BytesIO(content))
    return {'archive_sha256':receipt.sha(output),'bytes':output.stat().st_size,
            'candidate_manifest_sha256':receipt.sha(root/'candidate.json')}


if __name__=='__main__':
    import json
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();print(json.dumps(archive(a.candidate,a.output),sort_keys=True))
