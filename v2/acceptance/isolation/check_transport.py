"""Build containment in a disposable workspace; never edits Runtime registration."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wrapper', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--home', type=Path, required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--clippy', action='store_true', help='lint runtime and its tests without launching children')
    group.add_argument('--fmt', action='store_true', help='check formatting instead of tests')
    args = parser.parse_args()
    if not all(path.is_absolute() for path in (args.wrapper, args.target, args.home)):
        parser.error('wrapper, isolated target and disposable home parent must be absolute')
    args.home.mkdir(parents=True, exist_ok=True)
    workspace = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix='containment-check-', dir=args.home) as temporary:
        destination = Path(temporary) / 'v2'
        shutil.copytree(workspace, destination, ignore=shutil.ignore_patterns('target', '__pycache__'))
        library = destination / 'crates/orkestr-runtime/src/lib.rs'
        text = library.read_text()
        if 'pub mod containment;' not in text:
            library.write_text(text + '\npub mod containment;\n')
        env = {key: os.environ[key] for key in ('PATH', 'LANG') if key in os.environ}
        env.update(CARGO_TARGET_DIR=str(args.target), ORKESTR_V2_HOME=str(Path(temporary) / 'home'),
                   ORKESTR_MASTER_KEY='synthetic-must-not-reach-child',
                   OPENAI_API_KEY='synthetic-must-not-reach-child',
                   ORKESTR_BOOTSTRAP_TOKEN='synthetic-must-not-reach-child')
        if args.fmt:
            command = ['fmt', '-p', 'orkestr-runtime', '--', '--check']
        elif args.clippy:
            command = ['clippy', '--locked', '--offline', '-p', 'orkestr-runtime', '--all-targets', '--', '-D', 'warnings']
        else:
            command = ['test', '--locked', '--offline', '-p', 'orkestr-runtime', '--lib', 'containment::']
        return subprocess.run([str(args.wrapper), *command], cwd=destination, env=env, check=False).returncode


if __name__ == '__main__':
    raise SystemExit(main())
