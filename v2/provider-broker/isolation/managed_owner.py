"""V2-only cross-process owner seam; does not fence unmodified native writers."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import sqlite3
import stat
import threading
import uuid
from .managed_refresh import ManagedAccountRefresh


class ProfileOwner:
    def __init__(self, directory, account, identity, launch):
        self._root=Path(directory)
        self._account=Path(account)
        self._identity=identity
        self._launch=launch
        self._pid=os.getpid()
        if not isinstance(identity,str) or not 0<len(identity)<=256 or not callable(launch):raise ValueError('private owner configuration required')
        for path in (self._root,self._account.parent):
            if not path.is_absolute() or path.resolve()!=path:raise ValueError('canonical private path required')
            value=path.stat()
            if not stat.S_ISDIR(value.st_mode) or value.st_uid!=os.geteuid() or value.st_mode&0o077:
                raise ValueError('private owner directory required')
        self._root_id=self._inode(self._root)
        self._parent_id=self._inode(self._account.parent)
        self._file(self._account)
        self._lock=self._root/'owner.lock';self._db=self._root/'owner.sqlite'
        descriptor=os.open(self._lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        os.close(descriptor);self._file(self._lock);self._lock_id=self._inode(self._lock)
        descriptor=os.open(self._db,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        os.close(descriptor);self._file(self._db);self._db_id=self._inode(self._db)
        self._epoch=uuid.uuid4().hex
        with self._locked(),self._connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS profile(identity TEXT,account TEXT,parent TEXT,epoch TEXT,generation INTEGER,state TEXT,inode TEXT)')
            row=db.execute('SELECT * FROM profile').fetchone()
            if row is None:
                db.execute('INSERT INTO profile VALUES(?,?,?,?,?,?,?)',
                    (identity,str(self._account),str(self._parent_id),self._epoch,0,'ready',str(self._inode(self._account))))
            else:
                if row[:3]!=(identity,str(self._account),str(self._parent_id)) or row[5]!='ready':raise ValueError('owner reconciliation required')
                if row[6]!=str(self._inode(self._account)):raise ValueError('account replacement requires reconciliation')
                db.execute('UPDATE profile SET epoch=?',(self._epoch,))

    @staticmethod
    def _inode(path):
        value=path.lstat();return value.st_dev,value.st_ino

    @staticmethod
    def _file(path):
        value=path.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_nlink!=1 or value.st_uid!=os.geteuid() or value.st_mode&0o077:
            raise ValueError('unsafe private owner file')

    def __reduce__(self):raise TypeError('private profile owner')
    def __copy__(self):raise TypeError('private profile owner')
    def __deepcopy__(self,memo):raise TypeError('private profile owner')

    def _paths(self):
        if os.getpid()!=self._pid:raise ValueError('inherited owner refused')
        if self._root.resolve()!=self._root or self._account.parent.resolve()!=self._account.parent:raise ValueError('owner path changed')
        if self._inode(self._root)!=self._root_id or self._inode(self._account.parent)!=self._parent_id:raise ValueError('owner path changed')
        for path,pinned in ((self._lock,self._lock_id),(self._db,self._db_id)):
            self._file(path)
            if self._inode(path)!=pinned:raise ValueError('owner file changed')
        self._file(self._account)

    @contextmanager
    def _locked(self):
        self._paths()
        descriptor=os.open(self._lock,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            if (os.fstat(descriptor).st_dev,os.fstat(descriptor).st_ino)!=self._lock_id:raise ValueError('owner lock changed')
            fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self._paths()
            yield
        finally:os.close(descriptor)

    @contextmanager
    def _connection(self):
        self._paths()
        db=sqlite3.connect(self._db,timeout=0.2)
        try:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback();raise
        finally:db.close()

    def _current(self,db,state='ready'):
        row=db.execute('SELECT epoch,generation,state,inode FROM profile').fetchone()
        if row is None or row[0]!=self._epoch or row[2]!=state:raise ValueError('stale or unavailable owner')
        if state=='ready' and row[3]!=str(self._inode(self._account)):raise ValueError('account changed')
        return row[1]

    def select(self):
        try:
            with self._locked(),self._connection() as db:
                return ProfileHandle(self,self._current(db))
        except Exception:raise ValueError('selected profile unavailable') from None

    def _start(self,generation):
        try:
            with self._locked(),self._connection() as db:
                if self._current(db)!=generation:raise ValueError()
                # Fixed trusted callback: bounded owned spawn/fresh RO bind only.
                return self._launch()
        except Exception:raise ValueError('selected profile launch refused') from None

    def refresh(self,exchange,expected):
        try:
            with self._locked():
                with self._connection() as db:
                    generation=self._current(db)
                    # Durable BEFORE native side effect; death leaves uncertainty.
                    db.execute("UPDATE profile SET state='unknown'")
                verified=[]
                ManagedAccountRefresh(exchange,lambda:verified.append(True),expected)()
                self._paths()
                with self._connection() as db:
                    if self._current(db,'unknown')!=generation or verified!=[True]:raise ValueError()
                    db.execute("UPDATE profile SET state='ready',generation=?,inode=?",
                               (generation+1,str(self._inode(self._account))))
                return ProfileHandle(self,generation+1)
        except Exception:raise ValueError('managed owner refresh uncertain or refused') from None

    def revoke(self):
        # Revocation can overtake a network wait. It never authorizes a writer.
        try:
            with self._connection() as db:
                row=db.execute('SELECT epoch FROM profile').fetchone()
                if row is None or row[0]!=self._epoch:raise ValueError()
                db.execute("UPDATE profile SET state='revoked',generation=generation+1")
        except Exception:raise ValueError('owner revocation refused') from None


class ProfileHandle:
    __slots__=('_owner','_generation','_lock')
    def __init__(self,owner,generation):
        self._owner,self._generation,self._lock=owner,generation,threading.Lock()
    def __reduce__(self):raise TypeError('private profile handle')
    def __copy__(self):raise TypeError('private profile handle')
    def __deepcopy__(self,memo):raise TypeError('private profile handle')
    def launch(self):
        with self._lock:
            owner,self._owner=self._owner,None
        if owner is None:raise ValueError('selected profile consumed')
        return owner._start(self._generation)
