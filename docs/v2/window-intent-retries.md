# Window admission retries and idle native continuation

A scheduled occurrence commits its input and window intent together. Once the
timer advances, that intent is the durable record of pending work. Local window
admission errors keep the same intent queued and retry with exponential backoff
from five to sixty seconds. They never create another input or silently withdraw
the occurrence. FIFO order remains per conversation; other conversations can
continue. A server restart rediscovers the original queued rows.

After three failures the server emits a value-free `window_queue_deferred` alert.
Withdrawals required by an unavailable input or reconciliation emit
`window_queue_withdrawn` alerts. These contain only conversation/event IDs and a
closed cause vocabulary. Operators must inspect terminal withdrawals before
deciding whether any business action may be retried; migration never requeues
historical withdrawals.

Native readiness checks for an execution window consider only inputs admitted
to that window, matching the claim gate. An older unadmitted input cannot start
an idle continuation or spend its setup reservation.

Migration 0071 retains every native metadata reservation and scopes uniqueness
to the prior run and supervisor incarnation. A new reservation after already
confirmed idle setup requires a separately admitted successor window, exact
proven retirement and predecessor CAS, and matching prior context, terminal
event, binding and generation. Existing records are preserved. Issued or
mismatched setup remains fenced; the old incarnation cannot spend the new
reservation, and the generic non-window restart discovery remains unchanged.

Claude initialization records also retain their incarnation. A resumed process
needs its own matching native observation for the newly consumed run. Observing
that run updates only the current incarnation; an older unobserved initialization
remains unobserved. Missing current initialization evidence fails closed.
