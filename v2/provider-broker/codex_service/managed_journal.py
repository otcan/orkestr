"""In-memory index of the Root-private managed request journal.

Every claim stays one file, `<request_id>.json`, in the 0700 Root directory;
this manager is that directory's only writer, and only `Ingress._record`
creates a claim. The index therefore never has to read a claim to find one:

* `windows` maps a window to its claim ids, so per-window work (the claim
  bound, run close, Worker waiter count) reads at most that window's claims
  instead of the whole directory (2026-11-10: 857 claims took 110-160 ms per
  scan, and eight Deep windows' `managed_pending` calls missed their 5 s
  deadline).
* `unsettled` holds every claim that may still change state. A claim only
  moves forward (pending, consumed, worker_waiting, then completed, unknown or
  cancelled) and never back, so a superset that drops a claim once it reads
  as terminal stays exact.

Retention: a terminal claim of a window this manager no longer holds is
removed RETENTION_S after its last change. Idempotence never needs it then:
the claim key includes the window and its original broker identity, so no
later caller can replay it. Claims of held windows, unsettled claims and
claims of live callers are always kept.
"""
import os
import time

from codex_bounded.trust import metadata, protected
from .launch import atomic

TERMINAL = ('completed', 'unknown', 'cancelled')
# Audit copy of a closed window's claims (state backups keep older history).
RETENTION_S = 7 * 24 * 3600
PRUNE_EVERY_S = 3600
# Bounded work per manager tick: a large backlog is removed over several ticks.
PRUNE_BATCH = 256
PRUNE_RETRY_S = 1


class Journal:
    def __init__(self, directory):
        self.directory = directory
        self.windows = {}  # window_id -> {request_id}
        self.claims = {}  # request_id -> window_id
        self.unsettled = set()
        self.next_prune = 0.0  # Monotonic; the first tick prunes a previous life's claims.

    @classmethod
    def open(cls, directory, custody=protected):
        """Index every claim. A restarted manager cannot reconstruct original
        caller pidfd proof from disk: every unfinished claim becomes unknown,
        and none is redispatched."""
        journal = cls(directory)
        for path in directory.glob('*.json'):
            record = metadata(custody(path), 32768)
            if record['state'] not in TERMINAL:
                record['state'] = 'unknown'
                atomic(path, record)
            journal.add(path.stem, record['source']['window_id'], settled=True)
        return journal

    def path(self, request):
        return self.directory / (request + '.json')

    def add(self, request, window, settled=False):
        """Index a claim before its file is written: a failed write leaves at
        most a missing file, which every reader skips."""
        self.claims[request] = window
        self.windows.setdefault(window, set()).add(request)
        if not settled:
            self.unsettled.add(request)

    def count(self, window):
        return len(self.windows.get(window, ()))

    def window_paths(self, window):
        """Existing claim files of one window, in a stable order."""
        return [path for path in map(self.path, sorted(self.windows.get(window, ()))) if path.exists()]

    def unsettled_records(self):
        """(path, record) of each claim that may still change state."""
        for request in sorted(self.unsettled):
            path = self.path(request)
            try:
                record = metadata(path, 32768)
            except FileNotFoundError:
                self.unsettled.discard(request)
                continue
            if record['state'] in TERMINAL:
                self.unsettled.discard(request)
                continue
            yield path, record

    def _forget(self, request):
        window = self.claims.pop(request, None)
        requests = self.windows.get(window)
        if requests is not None:
            requests.discard(request)
            if not requests:
                del self.windows[window]
        self.unsettled.discard(request)

    def prune(self, held, live, now=None, wall=None):
        """Remove expired terminal claims of windows not in `held` and not
        named by a live caller in `live`. Returns the number removed."""
        now = time.monotonic() if now is None else now
        if now < self.next_prune:
            return 0
        wall = time.time() if wall is None else wall
        removed, more = 0, False
        for request, window in sorted(self.claims.items()):
            if window in held or request in live or request in self.unsettled:
                continue
            if removed >= PRUNE_BATCH:
                more = True
                break
            path = self.path(request)
            try:
                if path.stat().st_mtime > wall - RETENTION_S:
                    continue
                record = metadata(path, 32768)
            except FileNotFoundError:
                self._forget(request)
                continue
            if record['state'] not in TERMINAL or record['source']['window_id'] != window:
                continue
            os.unlink(path)
            self._forget(request)
            removed += 1
        self.next_prune = now + (PRUNE_RETRY_S if more else PRUNE_EVERY_S)
        return removed
