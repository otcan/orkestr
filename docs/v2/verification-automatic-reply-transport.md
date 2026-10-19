# Automatic reply transport source review

Reviewed server leaf `b56130d60b97bdd4a397a7dcc61ac982387baa72` against its
schema-39 base `b98a4835304afb59aa83641c3079054d3ce8d639`. No bounded source
blocker was found. This is an unregistered callable, not an activated transport.

The socket is transferred into a non-Clone writer before asynchronous setup.
Reservation replay, reconciliation, setup failure and dropped futures shut down
the endpoint without another write. Each actual nonblocking suffix uses only
Core-retained bytes under `with_automatic_reply_fence`, with a 16 KiB maximum.
Only `WouldBlock` maps to known zero bytes. Invalid limits, socket failures and
Store/commit uncertainty discard the capability and shut down the socket. Early
finish cannot write a remainder; full local writing remains `delivery_unknown`.

The producer receipt, four source hashes, manifest/lock hashes, raw test/lint logs
and retained test executable were independently hash-checked. The reported eight
socket tests remain producer execution evidence; this review did not rerun them.
The adapter tests do not demonstrate a socket callback followed by an uncertain
SQLite commit, and Core's separate callback failure tests do not supply that
missing adapter execution claim.

Composition must independently establish the exact privately configured endpoint
and exclusive ownership: a retained duplicate FD or deferred sender is outside
this leaf's protection. A local socket write is not remote delivery or ACK. No
registration, ingress trigger, account action or real network test was performed.

The separate pure UI state at `5c376b13daff0dca45752e216a0ca9e0e034236f` was
reviewed against DTO `d8b86f5e2180df98144d14e101a1ad89a7a90f31`. Its unchanged
Node tests independently passed 8/8. It validates scoped ordered pages, stages
updates atomically, freezes uncertain mutation tuples and clears state on explicit
selection/auth invalidation. Permission labels do not claim connection readiness.
This grants no mounting or HTTP credit. Future mounting must bind owner/session
lifetime, bound retained page history, and authenticate/validate mutation receipts;
the pure model does not implement these transport responsibilities.
