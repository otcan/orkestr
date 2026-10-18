#!/usr/bin/env python3
"""CI-callable native package and Docker context assembly; no builds or Docker calls."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import receipt

HERE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load('candidate_native', HERE/'package.py')
container = load('candidate_container', HERE/'docker/prepare.py')
from install_state import fresh_path, sha256


def assemble(binary, ui, paired, output, base, port):
    value = receipt.verify(json.loads(paired.read_text()), binary, ui)
    receipt.require(value['server']['profile'] == 'release', 'release candidate requires release-profile server')
    receipt.require(value['server']['features'] == [] and value['server']['default_features'] is True, 'candidate requires default features only; test controls refused')
    output = fresh_path(output, [binary, ui, paired, HERE])
    output.mkdir(mode=0o700)
    native.assemble(binary, output/'native', value['version'], value['source_commit'], ui)
    web_hashes = {name: info['sha256'] for name, info in value['web']['files'].items()}
    container.prepare(binary, ui, output/'docker', value['server']['sha256'], receipt.digest(web_hashes),
                      value['source_commit'], value['source_commit'], base, f'http://127.0.0.1:{port}', port,
                      'ORKESTR_V2_CONTAINER_BIND=1', value['build_contract']['required_glibc'])
    metadata = {'version': value['version'], 'source_commit': value['source_commit'],
                'schema': value['schema'], 'paired_receipt_sha256': sha256(paired)}
    for path in (output/'native/manifest.json', output/'docker/artifact-manifest.json'):
        content = json.loads(path.read_text()); content['release_metadata'] = metadata
        path.write_text(json.dumps(content, sort_keys=True, indent=2)+'\n')
    # Pair metadata is copied verbatim; neither packaging step starts a server or migrates state.
    (output/'paired-artifacts.json').write_bytes(paired.read_bytes())
    result = {'format': 'orkestr-v2-candidate-v1', 'version': value['version'],
              'source_commit': value['source_commit'], 'target': value['target'],
              'schema': value['schema'], 'files': container.ui_files(output),
              'acceptance': 'unexecuted; explicit isolated native/Docker probes required',
              'reproducibility': 'fixed artifact/tool identity; unique Docker project makes context bytes vary'}
    (output/'candidate.json').write_text(json.dumps(result, sort_keys=True, indent=2)+'\n')
    verify(output)
    return result


def verify(root):
    manifest = root/'candidate.json'
    receipt.require(not manifest.is_symlink(), 'candidate manifest symlink refused')
    value = json.loads(manifest.read_text())
    actual = container.ui_files(root)
    actual.pop('candidate.json', None)
    receipt.require(value['format'] == 'orkestr-v2-candidate-v1' and actual == value['files'], 'candidate inventory mismatch')
    paired = receipt.verify(json.loads((root/'paired-artifacts.json').read_text()), root/'native/server/orkestr-v2-server', root/'native/ui')
    receipt.require(paired['source_commit'] == value['source_commit'] and paired['schema'] == value['schema'], 'candidate source/schema mismatch')
    _, native_manifest = native.package(root/'native')
    receipt.require(native_manifest['version'] == paired['version'] == value['version'], 'candidate version mismatch')
    docker = json.loads((root/'docker/artifact-manifest.json').read_text())
    receipt.require(docker['server_source_commit_declared'] == paired['source_commit'] == docker['ui_source_commit_declared'], 'mixed-revision Docker artifacts refused')
    metadata = {'version': paired['version'], 'source_commit': paired['source_commit'],
                'schema': paired['schema'], 'paired_receipt_sha256': sha256(root/'paired-artifacts.json')}
    receipt.require(docker.get('release_metadata') == metadata == native_manifest.get('release_metadata'), 'release metadata mismatch')
    receipt.verify(paired, root/'docker/server', root/'docker/ui')
    return value


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest='command', required=True)
    check = commands.add_parser('verify'); check.add_argument('root', type=Path)
    build = commands.add_parser('assemble')
    for name in ('binary','ui','paired','output'):
        build.add_argument('--'+name, required=True, type=Path)
    build.add_argument('--base', required=True)
    build.add_argument('--port', type=int, required=True)
    a = p.parse_args()
    result = verify(a.root) if a.command == 'verify' else assemble(a.binary,a.ui,a.paired,a.output,a.base,a.port)
    print(json.dumps(result, sort_keys=True, indent=2))
