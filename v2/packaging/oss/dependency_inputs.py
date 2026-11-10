"""Deterministic download inputs, never a compilable substitute for real source."""
import json
from pathlib import Path
import subprocess
import sys
import tomllib


def create(root, output):
    root, output = Path(root).resolve(), Path(output)
    workspace = root / 'v2'
    metadata = json.loads(subprocess.check_output(
        ['cargo', 'metadata', '--no-deps', '--format-version', '1', '--offline', '--locked'],
        cwd=workspace, text=True))
    if Path(metadata['workspace_root']) != workspace:
        raise ValueError('unexpected Cargo workspace root')

    def relative(value):
        path = Path(value)
        if not path.is_file() or path.resolve() != path or not path.is_relative_to(root):
            raise ValueError('dependency input must be a regular in-repository file')
        return path.relative_to(root)

    manifests = {relative(workspace / name) for name in ('Cargo.toml', 'Cargo.lock')}
    targets = set()
    for package in metadata['packages']:
        manifests.add(relative(package['manifest_path']))
        for target in package['targets']:
            targets.add(relative(target['src_path']))
    # --no-deps deliberately excludes registry dependencies, including local
    # path patches. Their manifests must still exist when the download-only
    # layer resolves Cargo.lock. Keep target contents empty like workspace code.
    document = tomllib.loads((workspace / 'Cargo.toml').read_text())
    for scope in document.get('patch', {}).values():
        for specification in scope.values():
            if not isinstance(specification, dict) or 'path' not in specification:
                continue
            directory = workspace / specification['path']
            manifest = directory / 'Cargo.toml'
            manifests.add(relative(manifest))
            package = tomllib.loads(manifest.read_text())
            library = package.get('lib', {})
            library_path = directory / library.get('path', 'src/lib.rs')
            if library_path.exists() or library_path.is_symlink() or 'path' in library:
                targets.add(relative(library_path))
            for kind in ('bin', 'example', 'test', 'bench'):
                for target in package.get(kind, []):
                    if 'path' in target:
                        targets.add(relative(directory / target['path']))
            for default in ('src/main.rs', 'build.rs'):
                candidate = directory / default
                if candidate.exists() or candidate.is_symlink():
                    targets.add(relative(candidate))
            build = package.get('package', {}).get('build')
            if isinstance(build, str):
                targets.add(relative(directory / build))
    # Cargo discovers configuration relative to its working directory. Include
    # it in the key rather than silently using a different registry or flags.
    for parent in (root, workspace):
        for name in ('.cargo/config', '.cargo/config.toml', 'rust-toolchain.toml'):
            path = parent / name
            if path.exists() or path.is_symlink():
                manifests.add(relative(path))
    manifests.update(relative(root / name) for name in ('package.json', 'package-lock.json'))
    if (root / '.npmrc').exists() or (root / '.npmrc').is_symlink():
        manifests.add(relative(root / '.npmrc'))
    if manifests & targets:
        raise ValueError('Cargo target overlaps a dependency manifest')

    output.mkdir()
    for path in sorted(manifests | targets):
        destination = output / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((root / path).read_bytes() if path in manifests else b'')


if __name__ == '__main__':
    create(*sys.argv[1:])
