"""Disposable startup isolation probes; binary execution requires explicit admission."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request

CASES = (
    'db-symlink-empty', 'db-symlink-bytes', 'db-dangling-symlink',
    'ancestor-symlink', 'home-symlink', 'db-hardlink',
    'wal-symlink', 'shm-symlink', 'wal-hardlink', 'shm-hardlink',
    'separated-homes',
)


def snapshot(root):
    """Capture names, bytes and link identities without traversing symlinks."""
    result = {}
    for path in sorted(root.rglob('*')):
        relative = str(path.relative_to(root))
        stat = path.lstat()
        if path.is_symlink():
            result[relative] = ('symlink', os.readlink(path), stat.st_ino)
        elif path.is_file():
            result[relative] = ('file', path.read_bytes(), stat.st_dev,
                                stat.st_ino, stat.st_nlink)
        elif path.is_dir():
            result[relative] = ('directory',)
        else:
            result[relative] = ('special', stat.st_mode)
    return result


def fixture(root, case):
    legacy, home = root / 'legacy', root / 'candidate'
    legacy.mkdir()
    home.mkdir()
    (legacy / 'sentinel').write_bytes(b'synthetic legacy sentinel\x00\xff')
    database = home / 'core.sqlite3'
    if case == 'ancestor-symlink':
        (root / 'alias').symlink_to(legacy, target_is_directory=True)
        home = root / 'alias' / 'nested'
    elif case == 'home-symlink':
        home.rmdir()
        home.symlink_to(legacy, target_is_directory=True)
    elif case != 'separated-homes':
        suffix = '-wal' if case.startswith('wal-') else '-shm' if case.startswith('shm-') else ''
        destination = legacy / ('core.sqlite3' + suffix)
        if case != 'db-dangling-symlink':
            destination.write_bytes(b'' if case == 'db-symlink-empty' else b'synthetic protected bytes\x00\xff')
        alias = Path(str(database) + suffix)
        if case.endswith('hardlink'):
            os.link(destination, alias)
        else:
            alias.symlink_to(destination)
    return home, legacy


def exercise(binary, case, timeout=4):
    # No caller-supplied homes: even a faulty binary only receives disposable paths.
    with tempfile.TemporaryDirectory(prefix='orkestr-isolation-') as temporary:
        root = Path(temporary)
        home, legacy = fixture(root, case)
        before = snapshot(root)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        env = {key: os.environ[key] for key in ('PATH', 'LANG') if key in os.environ}
        env.update(HOME=str(root), TMPDIR=str(root), ORKESTR_HOME=str(legacy),
                   ORKESTR_V2_HOME=str(home), ORKESTR_V2_BIND=f'127.0.0.1:{port}',
                   ORKESTR_V2_BOOTSTRAP_TOKEN=secrets.token_hex(32))
        # Pipes are drained by communicate; timeout bounds candidate startup.
        process = subprocess.Popen([str(binary)], cwd=root, env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ready = False
        try:
            if case == 'separated-homes':
                deadline = time.monotonic() + timeout
                while process.poll() is None and time.monotonic() < deadline:
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/v2/health', timeout=.2) as response:
                            ready = response.status == 200
                        if ready:
                            break
                    except (OSError, TimeoutError):
                        time.sleep(.02)
                if process.poll() is None:
                    process.terminate()
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        after = snapshot(root)
        changed = sorted(key for key in before.keys() | after.keys() if before.get(key) != after.get(key))
        if case == 'separated-homes':
            legacy_changed = [key for key in changed if key == 'legacy' or key.startswith('legacy/')]
            passed = ready and not legacy_changed and (home / 'core.sqlite3').is_file()
        else:
            diagnostic = stderr.decode(errors='replace').lower()
            refused = process.returncode > 0 and any(
                word in diagnostic for word in ('isolation', 'overlap', 'symlink', 'hardlink', 'alias'))
            passed = refused and not changed
        return {'case': case, 'passed': passed, 'ready': ready,
                'returncode': process.returncode, 'changed_paths': changed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--case', choices=CASES, action='append')
    args = parser.parse_args()
    if not args.binary.is_absolute() or not args.binary.is_file():
        parser.error('--binary must identify an absolute existing executable')
    results = [exercise(args.binary, case) for case in args.case or CASES]
    print(json.dumps(results, indent=2))
    return 0 if all(result['passed'] for result in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
