# Inner provider egress capacity diagnostic

The authenticated namespace supervisor retains its fixed four simultaneous
relay limit. A fifth accepted TCP connection is closed before CONNECT parsing;
it never reaches the root-side endpoint. Idle live tunnels still occupy slots.
No automatic retry, eviction, extra worker, queue, endpoint, host or byte budget
is introduced.

The first capacity refusal per supervisor writes the fixed stderr line
`provider-egress: inner-capacity-refused`. Later refusals remain silent, bounding
volume independently of caller activity. The record contains no host, address,
account, request, TLS contents or native error. A failed stderr write does not
change refusal. The trusted operator must capture supervisor stderr privately;
a launcher discarding stderr will not expose this diagnostic. It must not be
interpreted as provider readiness, dispatch, refresh or cancellation evidence.

This identifies an inner admission refusal missing from outer-proxy evidence.
It does not attribute a native discovery error to that refusal. A fresh reviewed
immutable package and independently approved probe would be required to correlate
both events; no authenticated probe was executed for this change. Owner-scoped
connection eviction or queuing needs a separately reviewed lifetime policy:
opaque persistent tunnels cannot safely be classified as idle by application
meaning, and dropping one can interrupt an active inference.

`python3 -m unittest test_proxy_admission -v` from `v2/provider-broker` uses actual
loopback TCP connections and synthetic relay workers. It proves four admissions,
twelve pre-parse refusals, one bounded diagnostic, exact slot recovery after EOF,
worker cleanup and fail-closed behavior with a broken diagnostic sink. It does
not test live accounts, external networking or native error attribution.

## Stale-slot accounting

Worker liveness is sampled inside admission, after blocking accept returns. A
relay that exits during accept therefore frees its slot for that connection.
Sampling only before accept can refuse with three live workers and one dead
entry. The single accept-loop owner is the only worker creator; after pruning,
workers can finish but no competing creator can increase the live count.
A worker finishing just after the sample can still cause a conservative refusal;
this change does not promise fairness or queueing under genuine saturation.

`python3 -m unittest test_proxy_stale_slot -v` forces the reported schedule in
`supervisor.main`, using actual TCP accept and owned synthetic relay threads.
It checks admission after an exit during accept, refusal with four live relays,
subsequent drain/recovery and cleanup. Moving pruning back before accept makes
this regression fail; the post-accept implementation passes. This is separate
from any attribution of a real native discovery failure.
