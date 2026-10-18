"""Private owner adapter for managed-auth reload; not a native refresh API.

One shared host owner must cover ALL account users, including legacy executors.
This local serialization is not evidence that such host-wide ownership exists.
Callbacks are trusted composition code, never client input or SQLite callbacks.
"""
import threading


class ManagedCodexOwner:
    __slots__=('_lock','_identity','_snapshot','_launch','_refresh','_failed','_seen')

    def __init__(self, identity, snapshot, launch, *, supported_refresh=None):
        if not isinstance(identity,str) or not 0<len(identity)<=256:
            raise ValueError('selected identity required')
        if not callable(snapshot) or not callable(launch):
            raise ValueError('private owner callbacks required')
        if supported_refresh is not None and not callable(supported_refresh):
            raise ValueError('private refresh callback required')
        self._lock=threading.RLock()
        self._failed,self._seen=False,-1
        self._identity,self._snapshot,self._launch=identity,snapshot,launch
        self._refresh=supported_refresh

    def __reduce__(self):raise TypeError('private managed owner')
    def __copy__(self):raise TypeError('private managed owner')
    def __deepcopy__(self,memo):raise TypeError('private managed owner')

    def _current(self):
        if self._failed:raise ValueError()
        record=self._snapshot()
        if (not isinstance(record,dict) or set(record)!={'identity','generation','state'}
                or record['identity']!=self._identity or record['state']!='ready'
                or type(record['generation']) is not int or record['generation']<0):
            raise ValueError('selected managed account unavailable')
        if record['generation']<self._seen:raise ValueError()
        self._seen=record['generation']
        return self._seen

    def select(self):
        try:
            with self._lock:return SelectedManagedProfile(self,self._current())
        except Exception:raise ValueError('selected managed account unavailable') from None

    def refresh(self):
        # No implementation is supplied for pinned internal-only token APIs.
        # This callback can only be installed after a supported host owner review.
        try:
            with self._lock:
                before=self._current()
                if self._refresh is None:raise ValueError()
                try:
                    self._refresh()
                    after=self._current()
                    if after<=before:raise ValueError()
                except Exception:
                    self._failed=True
                    raise
                return SelectedManagedProfile(self,after)
        except Exception:raise ValueError('managed refresh unavailable') from None

    def _start(self,generation):
        try:
            with self._lock:
                if self._current()!=generation:raise ValueError()
                # Trusted launcher freshly resolves/binds canonical auth here.
                # Callback performs bounded owned spawn, not wait or inference.
                return self._launch()
        except Exception:raise ValueError('selected managed launch unavailable') from None


class SelectedManagedProfile:
    """One-use selected handle; contains no credentials or caller-selected paths."""
    __slots__=('_owner','_generation','_lock')

    def __init__(self,owner,generation):
        self._owner,self._generation,self._lock=owner,generation,threading.Lock()

    def __reduce__(self):raise TypeError('private selected profile')
    def __copy__(self):raise TypeError('private selected profile')
    def __deepcopy__(self,memo):raise TypeError('private selected profile')

    def launch(self):
        with self._lock:
            owner,self._owner=self._owner,None
        if owner is None:raise ValueError('selected profile consumed')
        return owner._start(self._generation)
