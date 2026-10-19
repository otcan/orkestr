"""Read only process metadata of a synthetic server's own marked Python child."""
import os
from pathlib import Path


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return int(fields[1]), int(fields[19]), fields[0]
    except (FileNotFoundError, ProcessLookupError):
        return None


class OwnedToolProbe:
    def __init__(self, process, marker):
        self.process = process
        self.parent_identity = identity(process.pid)
        assert self.parent_identity is not None and process.poll() is None
        self.marker = marker.encode()
        self.observed = {}

    def running(self):
        assert self.process.poll() is None
        current_parent = identity(self.process.pid)
        assert current_parent is not None and current_parent[:2] == self.parent_identity[:2]
        # Discover ancestry from stat only, then inspect command lines exclusively
        # for this exact newly spawned server's descendants. No environment reads.
        tree = {}
        for name in os.listdir("/proc"):
            if name.isdigit():
                found = identity(int(name))
                if found is not None:
                    tree[int(name)] = found
        descendants = {self.process.pid}
        for _ in range(16):
            children = {pid for pid, value in tree.items() if value[0] in descendants}
            if children.issubset(descendants):
                break
            descendants.update(children)
        for pid in descendants - {self.process.pid}:
            try:
                argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
                if argv[0] != b"/usr/bin/python3" or b"-c" not in argv:
                    continue
                code = argv[argv.index(b"-c") + 1]
                if self.marker not in code:
                    continue
                current = identity(pid)
                if current is not None and current[:2] == tree[pid][:2] and current[2] != "Z":
                    self.observed[pid] = current[1]
            except (FileNotFoundError, ProcessLookupError):
                continue
        return bool(self.observed) and not self.gone()

    def gone(self):
        for pid, start in self.observed.items():
            current = identity(pid)
            if current is not None and current[1] == start:
                return False  # a zombie is not yet reaped
        return True
