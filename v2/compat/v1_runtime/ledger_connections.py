"""A binding worker keeps one SQLite connection to its ledger (ORK-772).

A pass used to open about a dozen connections, and each new connection read
the schema again and started with an empty page cache. Inside
`Ledger.keep_connection()` (the worker's run loop) the thread's blocks reuse
one connection, and each block still behaves as if it had its own:

* Only the thread that entered `keep_connection()` reuses; every other thread
  (V1's HTTP requests, the registry) opens and closes one per block as before.
  A connection is never shared between threads.
* A block nested in another block gets its own connection, closed at its end,
  so the outer transaction is never committed early.
* At the end of a block no transaction and no statement stays open: the
  block's cursors are closed, so an unfinished SELECT cannot keep a shared
  lock that would stop another connection from committing.
* Any error closes and forgets the connection, as the per-block connection was
  closed; the next block opens a new one.
* Each reuse first checks the ledger file's identity, so a replaced file is
  opened again instead of being written through the old file handle.
* Leaving `keep_connection()` closes the connection. Closing is explicit: a
  Python 3.12 sqlite3 connection that is merely dropped stays open until the
  cyclic garbage collector runs (its statement cache refers back to it), which
  is how the adapter once ran out of file descriptors (2026-10-29).
"""
import contextlib
import os
import sqlite3
import threading
import weakref

from .export_changes import ExportConnection


class LedgerConnection(ExportConnection):
    """Remembers the cursors it hands out, so a block can close them all."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.block_cursors = weakref.WeakSet()

    def cursor(self, *args, **kwargs):
        cursor = super().cursor(*args, **kwargs)
        self.block_cursors.add(cursor)
        return cursor

    # sqlite3.Connection's own shortcuts create their cursor internally.
    def execute(self, sql, parameters=(), /):
        return self.cursor().execute(sql, parameters)

    def executemany(self, sql, parameters, /):
        return self.cursor().executemany(sql, parameters)

    def executescript(self, script, /):
        return self.cursor().executescript(script)

    def close_cursors(self):
        for cursor in list(self.block_cursors):
            cursor.close()
        self.block_cursors.clear()


def _identity(path):
    try:
        status = os.stat(path)
    except OSError:
        return None
    return status.st_dev, status.st_ino


class Connections:
    def __init__(self, path, timeout=5):
        self.path, self.timeout = path, timeout
        self._local = threading.local()

    def _open(self):
        db = sqlite3.connect(self.path, timeout=self.timeout, factory=LedgerConnection)
        try:
            db.execute("PRAGMA synchronous=FULL")
            db.close_cursors()
        except BaseException:
            db.close()
            raise
        return db

    def _kept(self):
        """This thread's kept connection, reopened when the file was replaced."""
        local = self._local
        db, identity = local.db, _identity(self.path)
        if db is not None and (identity is None or identity != local.identity):
            local.db = None
            db.close()
            db = None
        if db is None:
            db = self._open()
            identity = _identity(self.path)
            if identity is not None:
                local.db, local.identity = db, identity
        return db

    def _forget(self, db):
        if getattr(self._local, "db", None) is db:
            self._local.db = None
        db.close()

    @contextlib.contextmanager
    def keep(self):
        """Reuse one connection for this thread's blocks; close it at the end."""
        local = self._local
        if getattr(local, "keeping", False):
            yield  # Already kept by an outer call on this thread.
            return
        local.keeping, local.db, local.busy = True, None, False
        try:
            yield
        finally:
            db, local.db, local.keeping = local.db, None, False
            if db is not None:
                db.close()

    @contextlib.contextmanager
    def connect(self, on_export=None):
        """Commit on success, roll back on an error; see the module docstring."""
        local = self._local
        outer = getattr(local, "keeping", False) and not local.busy
        db = self._kept() if outer else self._open()
        kept = outer and local.db is db
        if outer:
            local.busy = True
        try:
            db.on_export = on_export
            with db:
                yield db
            db.close_cursors()
        except BaseException:
            self._forget(db)
            raise
        else:
            # Never reused with a transaction open (closing rolls it back).
            if not kept or db.in_transaction:
                self._forget(db)
        finally:
            if outer:
                local.busy = False
