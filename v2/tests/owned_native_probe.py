"""External read-only host identity oracle for this fixture's owned native tree.

No provider-reported PID is used as a host PID or signal target. A namespace
locator must match the exact synthetic executable under the owned server tree.
"""
from pathlib import Path


def process_start(pid):
    try:
        # comm may contain spaces or parentheses; starttime is field 22.
        return int((Path("/proc") / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()[19])
    except (FileNotFoundError, ProcessLookupError):
        return None


def descendants(root):
    seen, pending = set(), [root]
    for _ in range(12):
        following = []
        for pid in pending:
            if pid in seen:
                continue
            seen.add(pid)
            assert len(seen) <= 128, "synthetic owned process tree exceeded bound"
            try:
                tasks = list((Path("/proc") / str(pid) / "task").iterdir())
            except FileNotFoundError:
                continue
            assert len(tasks) <= 256, "synthetic server thread count exceeded bound"
            for task in tasks:
                try:
                    following.extend(int(value) for value in (task / "children").read_text().split())
                except FileNotFoundError:
                    pass
        pending = [pid for pid in following if pid not in seen]
        if not pending:
            return seen - {root}
    raise AssertionError("synthetic owned process tree depth exceeded bound")


class OwnedNativeProbe:
    def __init__(self, provider):
        self.provider = str(provider).encode()
        self.identities = {}

    def observe(self, server_pid, rows):
        unknown = {(row["pid_namespace"], row["process_start"], row["pid"])
                   for row in rows} - self.identities.keys()
        if unknown:
            assert server_pid is not None, "native identity must be observed before server shutdown"
            matches = {}
            for pid in descendants(server_pid):
                root = Path("/proc") / str(pid)
                try:
                    argv = (root / "cmdline").read_bytes().split(b"\0")
                    # Fixed executable path, not arbitrary substring matches in a
                    # bwrap command which contains the provider later in argv.
                    if self.provider not in argv[:2]:
                        continue
                    status = (root / "status").read_text().splitlines()
                    namespace_pid = int(next(line for line in status if line.startswith("NSpid:")).split()[-1])
                    key = ((root / "ns/pid").stat().st_ino, process_start(pid), namespace_pid)
                    if key in unknown:
                        assert key not in matches, "ambiguous owned native identity"
                        matches[key] = (pid, key[1])
                except (FileNotFoundError, ProcessLookupError):
                    continue
            assert unknown == matches.keys(), "failed to observe exact owned native host identity"
            self.identities.update(matches)
        output = []
        for row in rows:
            key = (row["pid_namespace"], row["process_start"], row["pid"])
            output.append({**row, "namespace_pid": row["pid"], "pid": self.identities[key][0]})
        return output

    def gone(self):
        return all(process_start(pid) != start for pid, start in self.identities.values())
