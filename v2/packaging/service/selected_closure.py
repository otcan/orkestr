"""Private Linux x86_64 selected-service startup closure; no provider execution.

Use the fixed system Python with -I -S -B. Root must approve/pin this tool and
its adjacent closure.py before the first capture. The separate root-only receipt
is not part of the closed selected package. Capture reads exact Git source;
verify needs no repository and binds the CURRENT selector to that sealed root.
This covers the existing stdlib (including pyc and ELF extension dependencies),
not arbitrary future plugins, NSS configuration, a whole-host attestation, or
protection against a malicious root changing files after verification.
"""
import argparse
from contextlib import contextmanager
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import sysconfig

sys.path.insert(0, str(Path(__file__).resolve().parent))
import closure

FORMAT = 'orkestr-v2-selected-startup-closure-v1'
MAX_FILES, MAX_FILE, MAX_TOTAL = 20000, 512 * 1024**2, 4 * 1024**3
MAX_RECEIPT, TIMEOUT = 16 * 1024**2, 180
FIXED = ('/usr/bin/python3', '/bin/sh', '/usr/bin/bwrap', '/usr/bin/prlimit', '/usr/bin/readelf')
LOADER = ('/etc/ld.so.cache', '/etc/ld.so.conf')
HEX = re.compile('[0-9a-f]{64}')
require = closure.require


def _canonical(path, depth=0):
    """Permit root-owned selectors, but check symlink targets' ancestry too."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts and depth < 24, 'canonical selector required')
    current = Path('/')
    for component in path.parts[1:]:
        current /= component
        value = current.lstat()
        require(value.st_uid == 0, 'root-owned path required')
        if stat.S_ISLNK(value.st_mode):
            target = Path(os.path.abspath(current.parent / os.readlink(current)))
            _canonical(target, depth + 1)
        else:
            require(not value.st_mode & 0o022, 'nonwritable ancestry required')
    return closure.trusted(path)


def _metadata(value):
    return dict(dev=value.st_dev, ino=value.st_ino, uid=value.st_uid, gid=value.st_gid,
                mode=stat.S_IMODE(value.st_mode), nlink=value.st_nlink,
                bytes=value.st_size, mtime_ns=value.st_mtime_ns, ctime_ns=value.st_ctime_ns)


def _pin(path):
    path = _canonical(path)
    require(path.name != 'auth.json', 'credential inventory refused')
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= MAX_FILE,
            'bounded single-link regular file required')
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        require(_metadata(os.fstat(stream.fileno())) == _metadata(before), 'file changed before read')
        total = 0
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            total += len(chunk); require(total <= MAX_FILE, 'file size bound')
            digest.update(chunk)
        require(total == before.st_size and _metadata(os.fstat(stream.fileno())) == _metadata(before)
                and _metadata(path.stat()) == _metadata(before), 'file changed during read')
    return dict(path=str(path), sha256=digest.hexdigest(), **_metadata(before))


def _decode(data):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            require(key not in out, 'duplicate metadata key'); out[key] = value
        return out
    value = json.loads(data.decode('utf-8', 'strict'), object_pairs_hook=unique,
                       parse_constant=lambda _: require(False, 'finite metadata required'))
    require(type(value) is dict, 'metadata object required')
    return value


def _json(path, maximum=MAX_RECEIPT):
    record = _pin(path); require(record['bytes'] <= maximum, 'metadata size bound')
    data = Path(record['path']).read_bytes()
    require(hashlib.sha256(data).hexdigest() == record['sha256'], 'metadata changed')
    return _decode(data), record


def _private_boundary(inner, tree):
    # Preflight ALL artifact metadata before opening any artifact. Only the two
    # fixed configuration objects may then be read to learn private references.
    for path, resolved in tree['files'].items():
        value = Path(path).lstat()
        require(path == resolved and stat.S_ISREG(value.st_mode) and value.st_nlink == 1,
                'nonalias single-link selected content required')
    def configuration(name):
        path = inner / name; before = path.stat()
        require(before.st_size <= 32768, 'configuration size bound')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as stream:
            require(_metadata(os.fstat(stream.fileno())) == _metadata(before), 'configuration changed')
            data = stream.read(32769)
            require(len(data) == before.st_size and _metadata(path.stat()) == _metadata(before)
                    and _metadata(os.fstat(stream.fileno())) == _metadata(before), 'configuration changed')
        return _decode(data)
    runtime, profile = configuration('service.json'), configuration('profile.json')
    require(runtime.get('format') == 'orkestr-v2-codex-service-v1' and
            profile.get('format') == 'orkestr-v2-codex-isolated-v2', 'selected configuration required')
    names = [runtime[k] for k in ('home', 'bootstrap_file', 'ledger_directory', 'endpoint_directory')]
    names += [profile[k] for k in ('auth_file', 'state_root', 'workspace')]
    require(all(type(p) is str and Path(p).is_absolute() for p in names), 'absolute private references required')
    forbidden = [Path(p).resolve(strict=True) for p in names]
    identities = {(Path(p).stat().st_dev, Path(p).stat().st_ino)
                  for p in (runtime['bootstrap_file'], profile['auth_file'])}
    for name in (*tree['files'], *tree['directories']):
        path = Path(name); value = path.stat()
        require(all(path != p and p not in path.parents for p in forbidden) and
                (value.st_dev, value.st_ino) not in identities, 'private artifact alias refused')


def _tree(root):
    root = _canonical(root); files, directories, pending, total = {}, {}, [root], 0
    while pending:
        directory = pending.pop()
        s = directory.stat()
        directories[str(directory)] = dict(dev=s.st_dev, ino=s.st_ino, uid=s.st_uid,
                                           gid=s.st_gid, mode=stat.S_IMODE(s.st_mode))
        for entry in sorted(directory.iterdir()):
            require(len(files) + len(directories) + len(pending) < MAX_FILES, 'inventory count bound')
            resolved = _canonical(entry)
            if entry.is_dir():
                require(not entry.is_symlink(), 'directory aliases unsupported')
                pending.append(entry)
            else:
                s = resolved.stat()
                require(entry.name != 'auth.json' and stat.S_ISREG(s.st_mode)
                        and s.st_size <= MAX_FILE, 'regular bounded noncredential tree required')
                total += s.st_size; require(total <= MAX_TOTAL, 'inventory byte bound')
                files[str(entry)] = str(resolved)
    return dict(files=files, directories=directories)


def _tools():
    root = Path(__file__).resolve().parent
    require(Path(closure.__file__).resolve() == root / 'closure.py', 'adjacent trusted helper required')
    return {str(p): _pin(p) for p in (root / 'selected_closure.py', root / 'closure.py')}


@contextmanager
def _bounded():
    require(not any(name.startswith('LD_') for name in os.environ)
            and not Path('/etc/ld.so.preload').exists(), 'loader overrides unsupported')
    require(os.geteuid() == 0 and sys.flags.isolated and sys.flags.no_site
            and sys.flags.dont_write_bytecode, 'root -I -S -B required')
    require(Path(sys.executable).resolve() == Path('/usr/bin/python3').resolve(), 'fixed system Python required')
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'caller timer unsupported')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(*_): raise TimeoutError('closure deadline')
    signal.signal(signal.SIGALRM, expired); signal.setitimer(signal.ITIMER_REAL, TIMEOUT)
    try: yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)


def _binding(selector, manifest_sha, release_sha):
    require(HEX.fullmatch(manifest_sha) and HEX.fullmatch(release_sha), 'exact metadata pins required')
    inner = _canonical(selector); release = inner.parent
    require(inner.name == 'package', 'selected package layout required')
    tree = _tree(release); _private_boundary(inner, tree)
    manifest, mp = _json(inner / 'manifest.json', 1024**2)
    published, rp = _json(release / 'release.json')
    require(mp['sha256'] == manifest_sha and rp['sha256'] == release_sha, 'selected metadata pin mismatch')
    require(manifest.get('format') == 'orkestr-v2-codex-service-package-v1'
            and published.get('format') == 'orkestr-v2-selected-service-release-v1'
            and published.get('inner_manifest_sha256') == manifest_sha
            and published.get('source_commit') == manifest.get('source_commit')
            and re.fullmatch('[0-9a-f]{40}', manifest.get('source_commit', '')),
            'selected source/manifest binding required')
    expected = set(published['files']) | {'release.json'}
    require({str(Path(p).relative_to(release)) for p in tree['files']} == expected,
            'outer release inventory changed')
    pins = {str(p): _pin(p) for p in tree['files'].values()}
    for name, value in published['files'].items():
        actual = pins[str(release / name)]
        require(actual['sha256'] == value['sha256'] and actual['bytes'] == value['bytes'],
                'outer release file changed')
    command = [str(_canonical('/usr/bin/python3')), '-I', '-S', '-B',
               str(inner / 'codex_service/entry.py'), 'manager', manifest_sha]
    expected_entry = ('#!/bin/sh\nset -eu\n[ "$#" -eq 0 ] || exit 2\n'
                      'unset ENV BASH_ENV CDPATH\nexec ' + shlex.join(command) + '\n').encode()
    require(pins[str(release / 'start-service')]['sha256'] == hashlib.sha256(expected_entry).hexdigest(),
            'fixed outer entry binding required')
    return dict(package_root=str(inner), release_root=str(release), source_commit=manifest['source_commit'],
                manager_manifest_sha256=manifest_sha, release_sha256=release_sha,
                tree=tree, files=pins)


def _source(binding, repository):
    """Compare only public Python modules to literal Git blobs; never import Git code."""
    source = binding['source_commit']; root = Path(binding['package_root'])
    command = ['/usr/bin/git', '-c', 'safe.directory=' + str(repository), '-C', str(repository)]
    env = dict(PATH='/usr/bin:/bin', LANG='C', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
               GIT_NO_REPLACE_OBJECTS='1', GIT_ATTR_NOSYSTEM='1', GIT_NO_LAZY_FETCH='1', GIT_OPTIONAL_LOCKS='0')
    require(_canonical('/usr/bin/git').is_file(), 'trusted Git required')
    def git(*args):
        result = subprocess.run(command + list(args), check=True, capture_output=True, stdin=subprocess.DEVNULL, env=env, timeout=20)
        require(len(result.stdout) <= 16 * 1024**2, 'source bound'); return result.stdout
    modules = {}
    for path, record in binding['files'].items():
        relative = Path(path).relative_to(root.parent)
        if len(relative.parts) >= 3 and relative.parts[0] == 'package' and relative.suffix == '.py':
            name = str(relative.relative_to('package'))
            prefix, tail = name.split('/', 1)
            if prefix not in ('broker', 'isolation', 'codex_bounded', 'codex_service'): continue
            source_name = tail if prefix == 'broker' else name
            blob = git('show', source + ':v2/provider-broker/' + source_name)
            require(hashlib.sha256(blob).hexdigest() == record['sha256'], 'packaged source mismatch')
            modules[name] = record['sha256']
    require(0 < len(modules) <= 256, 'source module count bound')
    return modules


def _package(binding):
    # Binding hashes every protected source before this import. Capture has also
    # checked exact Git bytes; verify has matched the independently pinned receipt.
    root = Path(binding['package_root'])
    require(not any(n in sys.modules for n in ('codex_service', 'codex_bounded')), 'fresh verifier process required')
    sys.path.insert(0, str(root))
    try:
        module = importlib.import_module('codex_service.package')
        return module.Package(root, binding['manager_manifest_sha256'])
    finally:
        sys.path.remove(str(root))


def _excluded(package):
    return tuple(Path(p).resolve() for p in (package.runtime['bootstrap_file'], package.profile['auth_file'],
        package.home, package.profile['workspace'], package.profile['state_root'], package.ledger_directory,
        Path(package.control).parent))


def _separate(paths, package):
    for path in map(Path, paths):
        require(all(path != excluded and excluded not in path.parents for excluded in _excluded(package)),
                'state/credential inventory refused')


def _elf_graphs(seeds):
    require(0 < len(seeds) <= 512, 'ELF seed bound')
    files, graphs = {}, {}
    for path in sorted(seeds):
        graph = closure.elf_files(path)
        files[graph['readelf']['path']] = graph['readelf']; files.update(graph['files'])
        require(len(files) <= MAX_FILES, 'runtime count bound')
        graphs[path] = sorted(graph['files'])
    return files, graphs


def _loader():
    files = {name: str(_canonical(name)) if Path(name).exists() else None for name in LOADER}
    directory = Path('/etc/ld.so.conf.d')
    tree = _tree(directory) if directory.exists() else None
    return dict(files=files, tree=tree)


def _runtime(package):
    stdlib = _canonical(sysconfig.get_path('stdlib'))
    require(stdlib.is_relative_to('/usr/lib') or stdlib.is_relative_to('/usr/local/lib'), 'trusted stdlib root required')
    tree = _tree(stdlib); _separate(tree['files'].values(), package)
    value = closure.python_files()  # Includes existing .pyc and currently mapped native code.
    files = {**value['files'], **value['native']}
    loader = _loader()
    extra = set(package.manifest['dependencies']) | {p for p in loader['files'].values() if p}
    if loader['tree']: extra.update(loader['tree']['files'].values())
    _separate(extra, package)
    files.update({p: closure.pin(p) for p in extra})
    require(set(value['files']) == set(tree['files'].values()) | {str(Path(sys.executable).resolve())},
            'Python inventory changed')
    fixed = {name: str(_canonical(name)) for name in FIXED}
    seeds = set(fixed.values()) | {str(package.root / 'server'), str(package.root / 'native')}
    for path in files:
        with Path(path).open('rb') as stream:
            if stream.read(4) == b'\x7fELF': seeds.add(path)
    dependencies, graphs = _elf_graphs(seeds); files.update(dependencies)
    require(len(files) <= MAX_FILES, 'runtime count bound')
    _separate(files, package)
    pins = {path: _pin(path) for path in files}
    require(sum(p['bytes'] for p in pins.values()) <= MAX_TOTAL, 'runtime byte bound')
    for path, before in files.items():
        require(all(pins[path][k] == before[k] for k in before), 'runtime changed during capture')
    require(_tree(stdlib) == tree, 'stdlib changed during capture')
    return dict(files=pins, stdlib_root=str(stdlib), tree=tree, fixed=fixed,
                elf_seeds=sorted(seeds), elf_graphs=graphs, loader=loader)


def capture(package, release, source_repository):
    """Caller supplies an already validated Package; no state content is read."""
    with _bounded():
        tools = _tools(); release = _canonical(release)
        require(package.root == release / 'package', 'selected release/package mismatch')
        binding = _binding(package.root, _pin(package.root / 'manifest.json')['sha256'],
                           _pin(release / 'release.json')['sha256'])
        _separate(binding['files'], package); _separate(tools, package)
        modules = _source(binding, source_repository); runtime = _runtime(package)
        require(_binding(package.root, binding['manager_manifest_sha256'], binding['release_sha256']) == binding,
                'release changed during capture')
        return dict(format=FORMAT, flags=['-I', '-S', '-B'], binding=binding, source_modules=modules,
                    tools=tools, runtime=runtime, credential_contents_read=False, provider_invoked=False,
                    limits=['Linux x86_64, fixed system roots, existing stdlib/pyc and recursive ELF dependencies',
                            'future plugins and configuration-selected dlopen unsupported; not whole-host attestation',
                            'root approval of tool/receipt required; no protection from later privileged mutation'])


def verify(receipt, package, release):
    """Rehash the sealed closure; a different current selector cannot reuse it."""
    with _bounded():
        require(receipt.get('format') == FORMAT and receipt.get('flags') == ['-I', '-S', '-B'], 'closure format')
        old = receipt['binding']
        require(_canonical(release) == Path(old['release_root']) and package.root == Path(old['package_root']),
                'selected release changed')
        require(_binding(package.root, old['manager_manifest_sha256'], old['release_sha256']) == old,
                'selected binding changed')
        require(_tools() == receipt['tools'], 'closure tool changed')
        runtime = receipt['runtime']
        require(runtime['fixed'] == {name: str(_canonical(name)) for name in FIXED}, 'fixed dependency selector changed')
        require(runtime['stdlib_root'] == str(_canonical(sysconfig.get_path('stdlib')))
                and _tree(runtime['stdlib_root']) == runtime['tree'], 'stdlib inventory changed')
        require(0 < len(runtime['files']) <= MAX_FILES
                and sum(p['bytes'] for p in runtime['files'].values()) <= MAX_TOTAL, 'runtime count/byte bound')
        _separate(runtime['files'], package)
        require(_loader() == runtime['loader'], 'loader configuration selectors changed')
        for path, expected in runtime['files'].items():
            require(_pin(path) == expected, 'startup dependency changed')
        _, graphs = _elf_graphs(runtime['elf_seeds'])
        require(graphs == runtime['elf_graphs'], 'ELF dependency resolution changed')
        return {'verified': True, 'package_root': str(package.root), 'source_commit': old['source_commit']}


def _write(path, value, package):
    path = Path(path); parent = _canonical(path.parent)
    require(parent == path.parent and not path.exists() and not path.is_symlink(), 'fresh canonical receipt required')
    require(not path.is_relative_to(package.root.parent), 'receipt must stay outside selected release')
    _separate([path], package)
    data = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    require(len(data) <= MAX_RECEIPT, 'receipt size bound')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), 0o600); stream.write(data); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    return _pin(path)['sha256']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('capture', 'verify'))
    parser.add_argument('--package', type=Path, required=True)
    for name in ('source-repository', 'output', 'receipt'):
        parser.add_argument('--' + name, type=Path)
    for name in ('manifest-sha256', 'release-sha256', 'receipt-sha256'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    with _bounded():
        _tools()
        if args.operation == 'capture':
            require(args.source_repository and args.output and args.manifest_sha256 and args.release_sha256,
                    'capture pins required')
            binding = _binding(args.package, args.manifest_sha256, args.release_sha256)
            _source(binding, args.source_repository)
        else:
            require(args.receipt and args.receipt_sha256 and HEX.fullmatch(args.receipt_sha256), 'receipt pin required')
            receipt, record = _json(args.receipt)
            require(record['sha256'] == args.receipt_sha256 and record['mode'] == 0o600, 'private receipt pin/custody')
            require(receipt.get('format') == FORMAT and _tools() == receipt['tools'], 'closure tool/format changed')
            old = receipt['binding']
            binding = _binding(args.package, old['manager_manifest_sha256'], old['release_sha256'])
            require(binding == old, 'selected release changed')
        package = _package(binding)
    if args.operation == 'capture':
        value = capture(package, package.root.parent, args.source_repository)
        print(json.dumps({'receipt_sha256': _write(args.output, value, package), 'activated': False}))
    else:
        print(json.dumps(verify(receipt, package, package.root.parent)))


if __name__ == '__main__':
    try: main()
    except Exception:
        sys.stderr.write('selected service startup closure refused\n'); raise SystemExit(2)
