"""Container root keeps current privileges; every exec descendant gets no caps.

The root manager must run the already-verified protected entry IN THIS PROCESS:
an intervening root exec would lose its required /proc observation capability.
No manager, provider protocol, peer check or package inventory is modified.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import sys


def masks():
    return {key: int(value.strip(), 16) for line in Path('/proc/self/status').read_text().splitlines()
            if line.startswith('Cap') for key, value in [line.split(':', 1)]}


def set_no_new_privileges():
    """Same as `--security-opt no-new-privileges`, so a plain `docker run`
    without that flag keeps the model: no exec in this tree can gain privileges."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise RuntimeError('no_new_privs refused')
    if libc.prctl(39, 0, 0, 0, 0) != 1:  # PR_GET_NO_NEW_PRIVS
        raise RuntimeError('no_new_privs verification failed')


def drop_child_capabilities():
    if os.geteuid() != 0:
        raise RuntimeError('capability setup requires container root')
    libc = ctypes.CDLL(None, use_errno=True)
    class Header(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32),
                    ('inheritable', ctypes.c_uint32)]
    header, data = Header(0x20080522, 0), (Data * 2)()
    before = masks()
    if libc.capget(ctypes.byref(header), ctypes.byref(data)) != 0:
        raise RuntimeError('capability read refused')
    for word in data:
        word.inheritable = 0
    if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
        raise RuntimeError('inheritable capability clear refused')
    if libc.prctl(47, 4, 0, 0, 0) != 0:  # PR_CAP_AMBIENT / CLEAR_ALL
        raise RuntimeError('ambient capability clear refused')
    last = int(Path('/proc/sys/kernel/cap_last_cap').read_text())
    if not 0 <= last <= 63:
        raise RuntimeError('unsupported capability inventory')
    for capability in range(last + 1):
        if libc.prctl(24, capability, 0, 0, 0) != 0:  # PR_CAPBSET_DROP
            raise RuntimeError('bounding capability drop refused')
    after = masks()
    if any(after[key] for key in ('CapBnd', 'CapInh', 'CapAmb')) \
            or any(after[key] != before[key] for key in ('CapEff', 'CapPrm')):
        raise RuntimeError('capability transition verification failed')


def protected(path):
    if path.resolve(strict=True) != path:
        raise RuntimeError('release alias refused')
    for item in (path, *path.parents):
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('release custody refused')
    return path


def manager(release):
    receipt = json.loads(protected(release / 'release.json').read_text())
    entry = protected(release / 'package/codex_service/entry.py')
    expected = receipt['files']['package/codex_service/entry.py']['sha256']
    if hashlib.sha256(entry.read_bytes()).hexdigest() != expected:
        raise RuntimeError('protected manager entry hash refused')
    manifest = receipt['inner_manifest_sha256']
    if hashlib.sha256(protected(release / 'package/manifest.json').read_bytes()).hexdigest() != manifest:
        raise RuntimeError('protected manifest hash refused')
    drop_child_capabilities()
    # Full protected entry still validates every package byte before importing it.
    # Its manager remains this root PID; dropped server/provider execs inherit Bnd=0.
    sys.argv = [str(entry), 'manager', manifest]
    runpy.run_path(str(entry), run_name='__main__')


if __name__ == '__main__':
    if len(sys.argv) != 2 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        raise SystemExit('isolated no-site manager invocation required')
    manager(Path(sys.argv[1]))
