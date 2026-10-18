# Timer-only supervisor lifecycle

`Store::authorize_timer_supervisor(machine_credential)` owns the reserved
`orkestr:durable-timers` / `ordinary-timer-scheduler` context. It authenticates the
current 64-hex machine credential inside BEGIN IMMEDIATE, discovers only that
owner's reserved context, and creates or replaces an expired predecessor in the
same transaction. A live predecessor is Busy. Replacement refuses any provider
readiness or runs; it never performs provider takeover or recovers native state.

`retire_timer_supervisor()` is a negative-only graceful release after the server
stops scheduler work. It checks the current bound credential/context, refuses
provider evidence and expires the exact incarnation. A fresh process can then
bootstrap immediately. Old issuers fail; current machine revocation refuses
bootstrap, release and scheduler transactions. The reserved context cannot issue
provider metadata/readiness. No serialized browser field or caller-selected
predecessor supplies authority.

The trusted timer service can explicitly opt into
`renew_timer_supervisor_credential()`. This validates the current machine session
and live reserved context under BEGIN IMMEDIATE before extending that same
session to a bounded twelve-hour window. It returns only the expiry, never a
credential. The service should renew well before expiry and heartbeat separately.
No secret is copied or minted; each scheduler transaction still checks current
DB auth. Explicit session deletion immediately revokes the service. Expired or
revoked sessions cannot be renewed or resurrected, and non-timer contexts cannot
use this method. A stopped service that misses expiry needs fresh owner-authorized
machine provisioning; bootstrap does not bypass that requirement.

This rolling service-session lifecycle is an explicit trusted-server opt-in, not
a browser operation or automatic extension during reads/admission. It has Store
coverage only; daily/weekly mounted-process and restart qualification remain
separate. A crashed live context remains Busy until its real deadline.
