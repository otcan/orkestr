"""Root-owned managed job subtrees; executor receives no controller FD.

The selected service provisions an empty Root-owned jobs subtree. This module
never changes a live service/unit or delegates its common ancestor to a user.
"""
import os
from pathlib import Path
import stat
import time

from .contract import identifier, require


def resources(profile):
    fields = {'memory_bytes': (256 * 1024**2, 64 * 1024**3, 8 * 1024**3),
              'pids': (16, 4096, 1024), 'cpus': (1, 16, 4),
              'file_bytes': (1024**2, 64 * 1024**3, 4 * 1024**3),
              'open_files': (64, 65536, 4096)}
    result = {}
    for name, (low, high, default) in fields.items():
        value = profile.get(name, default)
        require(type(value) is int and low <= value <= high, 'managed_job_resource_bound')
        result[name] = value
    return result


def read(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory)
    try:
        value = os.read(fd, 4097)
        require(len(value) <= 4096, 'managed_cgroup_read_bound')
        return value.decode('ascii', 'strict').strip()
    finally: os.close(fd)


def write(directory, name, value):
    fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory)
    try:
        raw = value.encode('ascii'); require(os.write(fd, raw) == len(raw), 'managed_cgroup_write')
    finally: os.close(fd)


class Root:
    def __init__(self, selected):
        require(os.geteuid() == 0, 'managed_cgroup_root_required')
        raw = str(selected); path = Path(raw)
        require(raw.startswith('/sys/fs/cgroup/') and all(v not in ('', '.', '..') for v in raw.split('/')[1:]),
                'managed_cgroup_path')
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            for part in path.parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd); fd = child
                meta = os.fstat(fd)
                require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and meta.st_mode & 0o022 == 0,
                        'managed_cgroup_custody')
            require(os.fstat(fd).st_dev == Path('/sys/fs/cgroup').stat().st_dev and
                    not read(fd, 'cgroup.procs') and
                    {'cpu', 'memory', 'pids'} <= set(read(fd, 'cgroup.subtree_control').split()),
                    'managed_cgroup_controllers')
            self.fd = fd; fd = None; self.path = path
            meta = os.fstat(self.fd); self.identity = (meta.st_dev, meta.st_ino)
        finally:
            if fd is not None: os.close(fd)

    def check(self):
        now = self.path.stat(follow_symlinks=False)
        require(stat.S_ISDIR(now.st_mode) and now.st_uid == 0 and now.st_mode & 0o022 == 0 and
                (now.st_dev, now.st_ino) == self.identity, 'managed_cgroup_replaced')

    def job(self, operation, limits):
        identifier(operation); self.check()
        name = 'job-' + operation
        # Existing/unknown targets never authorize reuse or an automatic replay.
        os.mkdir(name, mode=0o700, dir_fd=self.fd)
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
        job = Job(self, name, fd)
        try:
            os.fchmod(fd, 0o700)
            for key, value in {'memory.max': str(limits['memory_bytes']), 'memory.swap.max': '0',
                               'pids.max': str(limits['pids']), 'cpu.max': str(limits['cpus'] * 100000) + ' 100000'}.items():
                write(fd, key, value)
                require(read(fd, key) == value, 'managed_cgroup_limit_readback')
            require(not job.populated(), 'managed_job_not_empty')
            return job
        except BaseException:
            job.close_empty(); raise

    def close(self):
        os.close(self.fd)


class Job:
    def __init__(self, root, name, fd):
        self.root, self.name, self.fd = root, name, fd
        meta = os.fstat(fd); self.identity = (meta.st_dev, meta.st_ino)

    def check(self):
        self.root.check()
        meta = os.stat(self.name, dir_fd=self.root.fd, follow_symlinks=False)
        require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and meta.st_mode & 0o077 == 0 and
                (meta.st_dev, meta.st_ino) == self.identity, 'managed_job_replaced')

    def populated(self):
        self.check()
        lines = dict(line.split() for line in read(self.fd, 'cgroup.events').splitlines())
        require(lines.get('populated') in ('0', '1'), 'managed_cgroup_events')
        return lines['populated'] == '1'

    def kill(self):
        self.check(); write(self.fd, 'cgroup.kill', '1')

    def empty(self, seconds):
        until = time.monotonic() + seconds
        while self.populated():
            self.kill()
            if time.monotonic() >= until: return False
            time.sleep(.005)
        return True

    def close_empty(self):
        require(not self.populated(), 'managed_job_cleanup_unknown')
        os.close(self.fd); self.fd = None
        os.rmdir(self.name, dir_fd=self.root.fd)
