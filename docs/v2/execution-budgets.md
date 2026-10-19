# Trusted execution budgets

The optional private execution configuration accepts an `execution_budget`:

```json
{"max_run_ms": 3600000, "max_idle_ms": 300000}
```

`max_run_ms` is required when this object is supplied and ranges from one second
through 24 hours. Optional `max_idle_ms` ranges from one second through that hard
limit. Omitting the object preserves the existing 45-second acceptance default
with no inactivity timeout. These values are trusted server configuration; HTTP
inputs cannot change them or supply execution authority.

Each newly consumed Deep run starts its own monotonic budget. Only committed
provider observations reset inactivity. Polling, supervisor heartbeat and lease
renewal do not count as progress or extend the hard limit. Expiry uses the same
durable cancellation receipt and native Stop path as an owner request, preserving
pre-Stop inputs as held. An ACK or local process kill is still not terminal proof.

Running work captures Core's opaque renewal authority from the original consumed
grant before attachment. Every 20 seconds the ordinary server attempts renewal
under the per-run scheduling lock, after current Running status and Runtime
quiescence checks. Buffered observations and partial writes defer that attempt.
The sealed Core/Runtime transition preserves the same process, native session,
turn, dispatch fence and event sequence while replacing only lease freshness.
It retires the old local authority; no new inference frame or process is created.
Core checks current machine authorization and supervisor/run state again within
the transaction. Failed or uncertain consuming transfers require reconciliation.

This policy currently applies to Deep runs. Worker tasks retain their separately
bounded delegation lifetime; renewing a parent does not extend a child. Completed
proposals await explicit owner acceptance. Long budgets do not authorize tools,
new provider accounts, new filesystem access or network capabilities.

The ordinary HTTP regression uses a fixed synthetic provider and natural elapsed
time: the original turn and externally observed host process remain alive beyond
60 seconds, multiple immutable lease generations exist, and one Stop using the
original control token confirms interruption. A separate case revokes the machine
after renewal and requires process cleanup without invented terminal observations.
