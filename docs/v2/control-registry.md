# Owned-run control registry

`control_registry` tracks live cancellation transport for independently owned
Deep and Worker runs. It does not issue cancellation authority. Each entry is
scoped to the factory's owner and conversation and one exact run, registered
only after native attachment. The non-cloneable `RunControl` owns that entry's
lifetime; dropping it refuses new Stop intent without claiming native exit.

The registry allows at most 16 active entries and retains the last 64 retired
entries for exact request replay. Active entries are never evicted. A retired
entry accepts only its previously published run, request key, projection
revision, optional run control revision, and identical internal receipt.
Replay does not redeliver an interrupt. Older
retired entries return unavailable after eviction. These bounds do not create
a dispatch queue or persist across server restart.

HTTP selects `RequestedControl`, acquires its async scheduling guard, and
rechecks `is_permitted()` before calling the existing same-transaction Core
authentication and cancellation API. Current authentication, run identity,
and Core's control precondition remain mandatory on every request and replay.
Only the exact committed internal receipt is published; the route serializes
the existing public receipt. The registry does not interpret projection
revisions, reconstruct authority, or accept browser-supplied provider state.

Each ordinary native pump step holds the same run's scheduling guard. Parent
composition acquires Deep then Worker when polling a child; it never acquires
those locks in reverse order. An HTTP Worker Stop takes only that Worker's
guard. No standard mutex is held across an await. Local deadline cancellation
uses the same mailbox but does not invent a browser request or replay tuple.

Publication only hands off a durable cancellation request. `control_dispatch`
and Runtime still require correlated native terminal evidence to record
`Stopped`; acknowledgement alone remains unresolved and owns bounded cleanup.
The registry's unit tests use synthetic receipt metadata to exercise scope,
locking, lifecycle, and capacity. They are not proof of current authority or
native execution. Actual authenticated HTTP and process checks provide that
separate evidence.
