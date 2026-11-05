"""Root-created native protocol pipes; shared executor UID cannot reopen them.

Descriptor custody grants no dispatch authority. Core still receives the sole
native writer through its original authenticated provider handoff.
"""
import ctypes
import fcntl
import os
import stat
import subprocess
from .contract import require

SLOTS = (7, 8, 9, 10)  # stdin read/write, stdout read/write


def validate(descriptors):
    require(len(descriptors) == 4 and len(set(descriptors)) == 4, 'native_io_count')
    identities = []
    for fd, direction in zip(descriptors, (os.O_RDONLY, os.O_WRONLY) * 2):
        info = os.fstat(fd)
        require(stat.S_ISFIFO(info.st_mode) and info.st_uid == 0
                and stat.S_IMODE(info.st_mode) == 0o600
                and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == direction,
                'native_io_custody')
        identities.append((info.st_dev, info.st_ino))
    require(identities[0] == identities[1] and identities[2] == identities[3]
            and identities[0] != identities[2], 'native_io_identity')


def create():
    require(os.geteuid() == 0, 'native_io_root_creator')
    result = []
    try:
        for _ in range(2):
            original = os.pipe2(os.O_CLOEXEC)
            try:
                for fd in original:
                    os.fchmod(fd, 0o600)
                    result.append(fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 20))
            finally:
                for fd in original: os.close(fd)
        validate(result)
        return result
    except BaseException:
        for fd in result: os.close(fd)
        raise


class NativeIO:
    def __init__(self, package):
        from .identity import launch_context
        require(package.identity_split and os.geteuid() == package.executor_uid
                and launch_context() is not None and ctypes.CDLL(None).prctl(39, 0, 0, 0, 0) == 1,
                'native_io_managed_launch')
        validate(SLOTS)
        self.package=package
        self.descriptors = []
        try:
            for fd in SLOTS:
                self.descriptors.append(fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 20))
        except BaseException:
            self.close(); raise
        finally:
            for fd in SLOTS: os.close(fd)

    def spawn(self, command, **kwargs):
        require(len(self.descriptors) == 4, 'native_io_already_consumed')
        descriptors, self.descriptors = self.descriptors, []
        reader, writer, output, native_output = descriptors
        try:
            validate(descriptors)
            input_file = os.fdopen(writer, 'wb', buffering=0); descriptors.remove(writer)
            output_file = os.fdopen(output, 'rb', buffering=0); descriptors.remove(output)
            try:
                kwargs.update(stdin=reader, stdout=native_output)
                child = subprocess.Popen(command, **kwargs)
            except BaseException:
                input_file.close(); output_file.close(); raise
            # Only simple assignment follows Popen: original ownership is not
            # lost to a fallible local descriptor-allocation step after spawn.
            child.stdin, child.stdout = input_file, output_file
            return child
        finally:
            for fd in descriptors: os.close(fd)

    def close(self):
        for fd in self.descriptors: os.close(fd)
        self.descriptors = []

    def attest(self,child):
        if not self.package.runtime.get('managed_operations'):return
        from .identity import launch_context
        context=launch_context()
        if context['role'] not in ('deep','claude') or context['setup']['role']!='deep':return
        from codex_bounded.trust import process
        from .contract import canonical
        from .managed_client import exchange
        identity=process(child.pid)
        require(identity and child.poll() is None,'native_io_owned_child_lost')
        reply=exchange(self.package.control.parent/'managed.sock',canonical({'version':1,'request_key':'native-register',
            'operation':'native_register','arguments':{'pid':child.pid,'start':identity['start']}}))
        require(reply['state']=='completed' and reply['result']=={'kind':'native_registration'},'native_io_registration_unknown')


def capture(package):
    return NativeIO(package) if package.identity_split else None
