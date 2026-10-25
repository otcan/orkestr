"""Clean-container build owner: targeted release server/UI, #265 bundle and pins."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

ROOT = Path('/src')
OUT = Path('/artifacts')


def run(argv, **kwargs):
    subprocess.run(argv, check=True, **kwargs)


def main():
    OUT.mkdir()
    source = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    version = tomllib.loads((ROOT / 'v2/Cargo.toml').read_text())['workspace']['package']['version']
    env = {**os.environ, 'V2_CARGO': '/usr/local/cargo/bin/cargo',
           'UI_EXECUTION_CONTROLS': '1', 'UI_SERVER_CANDIDATE': source,
           'UI_BUNDLE_DIR': str(OUT / 'ui')}
    run(['cargo', 'fetch', '--locked'], cwd=ROOT / 'v2', env=env)
    env['ORKESTR_V2_BUILD_IDENTITY'] = f'ORKESTR_V2_BUILD_IDENTITY_V1|server|{version}|{source}|END'
    run(['cargo', 'build', '--release', '--offline', '--locked', '-p', 'orkestr-v2-server'],
        cwd=ROOT / 'v2', env=env)
    import shutil
    shutil.copy2(Path(env['CARGO_TARGET_DIR']) / 'release/orkestr-v2-server', OUT / 'server')
    env['ORKESTR_V2_BUILD_IDENTITY'] = f'ORKESTR_V2_BUILD_IDENTITY_V1|web|{version}|{source}|END'
    run(['bash', str(ROOT / 'v2/apps/ui/scripts/bundle.sh')], env=env)
    sys.path.insert(0, str(ROOT / 'v2/packaging/candidate'))
    import receipt
    pair = receipt.seal(ROOT, OUT / 'server', OUT / 'ui', source, version, 'release', [],
                        '2.36', execution_controls=True)
    (OUT / 'paired-artifacts.json').write_text(json.dumps(pair, indent=2) + '\n')
    run([sys.executable, '-B', str(ROOT / 'v2/packaging/desktop/build_bundle.py'),
         '--out', str(OUT / 'distribution'), '--target', 'x86_64-unknown-linux-gnu',
         '--server-bin', str(OUT / 'server'), '--ui-dist', str(OUT / 'ui')])
    shutil.copy2(OUT / 'paired-artifacts.json', OUT / 'distribution/paired-artifacts.json')
    archives = sorted((OUT / 'distribution').glob('*.tar.gz'))
    (OUT / 'distribution/SHA256SUMS').write_text(''.join(
        hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in archives))
    run([sys.executable, '-I', '-S', '-B', str(ROOT / 'v2/packaging/oss/fetch_providers.py')])


if __name__ == '__main__':
    main()
