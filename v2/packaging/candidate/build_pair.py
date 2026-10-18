#!/usr/bin/env python3
"""Explicit build-owner entrypoint. Never invoked by package/verify or tests.

Requires preinstalled tools/caches; offline only. No dependency installation,
publication, service launch, provider credentials or Docker daemon operations.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import receipt


def build(checkout, output, source, version, wrapper, cargo_home, rustup_home, glibc, execution_controls=False):
    receipt.require(platform.system() == 'Linux' and platform.machine() == 'x86_64', 'Linux x86_64 build host required')
    checkout = checkout.resolve()
    receipt.require(receipt.git(checkout,'rev-parse','HEAD') == source, 'exact checkout required')
    receipt.require(not receipt.git(checkout,'status','--porcelain','--untracked-files=normal'), 'clean tracked checkout required')
    receipt.require(wrapper.is_absolute() and wrapper.is_file(), 'absolute authorized V2_CARGO wrapper required')
    for cache in (cargo_home,rustup_home):
        receipt.require(cache.is_absolute() and cache.is_dir(), 'explicit existing offline tool cache required')
    # Reuse native path identity guards on the host, never inside overlay images.
    import sys
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'local-install'))
    from install_state import fresh_path
    output = fresh_path(output,[checkout,wrapper,cargo_home,rustup_home])
    output.mkdir(mode=0o700)
    (output/'build-home').mkdir(mode=0o700)
    env = {'PATH':str(cargo_home/'bin')+os.pathsep+os.environ.get('PATH',os.defpath), 'HOME':str(output/'build-home'),
           'CARGO_HOME':str(cargo_home), 'RUSTUP_HOME':str(rustup_home),
           'CARGO_TARGET_DIR':str(output/'target'), 'UI_BUNDLE_DIR':str(output/'ui'),
           'V2_CARGO':str(wrapper), 'CARGO_NET_OFFLINE':'true', 'CARGO_BUILD_JOBS':'4'}
    if execution_controls:
        env.update(UI_EXECUTION_CONTROLS='1', UI_SERVER_CANDIDATE=source)
    subprocess.run([str(wrapper),'build','--release','--offline','--locked','-p','orkestr-v2-server'],
                   cwd=checkout/'v2',env=env,check=True)
    subprocess.run(['bash',str(checkout/'v2/apps/ui/scripts/bundle.sh')],cwd=checkout,env=env,check=True)
    shutil.copy2(output/'target/release/orkestr-v2-server',output/'server')
    value = receipt.seal(checkout,output/'server',output/'ui',source,version,'release',[],glibc,execution_controls=execution_controls)
    (output/'paired-artifacts.json').write_text(json.dumps(value,sort_keys=True,indent=2)+'\n')
    return value


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('checkout','output','wrapper','cargo-home','rustup-home'):
        p.add_argument('--'+name,type=Path,required=True)
    for name in ('source','version','required-glibc'):
        p.add_argument('--'+name,required=True)
    p.add_argument('--execution-controls',action='store_true',help='Explicitly build controls UI bound to the exact server source')
    a=p.parse_args()
    print(json.dumps(build(a.checkout,a.output,a.source,a.version,a.wrapper,a.cargo_home,a.rustup_home,a.required_glibc,a.execution_controls),sort_keys=True,indent=2))
