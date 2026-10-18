# Host resources UI

The authenticated navigation exposes **Host resources**, separate from per-run
execution resources. CPU is aggregate host busy time; RAM is total minus Linux
available memory, which includes reclaimable memory. Other applications on the
host contribute. This is not per-process or per-provider accounting.

The read-only channel uses exactly `GET /api/v2/resources` with same-origin cookies,
no Bearer or CSRF header on the GET, no storage, and no control endpoints. It reuses
the bounded serial polling bridge (64 KiB responses, ten-second timeout, two-second
retry interval, one-second monotonic freshness ticks). Teardown aborts fetches and
cleans timers. Unauthorized responses expire the current session. Failed reads
show unavailable/stale state without substituting zeros.

`App` retains the authenticated owner's validated host sample across tab remounts.
The identity is `(instance_id, sample_sequence)`. Equal identities must have exactly
equal content and never refresh the original monotonic receipt anchor. Sequence
regression and changed equal-sequence content are rejected. A new server instance
can restart sequence numbering; a retired instance cannot later replay as new.
Retired history is bounded to 64 instances; exhausting it fails closed until the
owner cache is cleared by authentication transition. Wall-clock server timestamps
are not compared with browser clocks. Freshness expires after fifteen seconds of
local monotonic elapsed time without a new sample, independently of successful
cached HTTP reads. First receipt cannot establish time spent cached before arrival.

Ready, warming CPU, unavailable measurements, initial loading, and stale data have
separate presentation. Warming samples can show valid RAM while CPU is unavailable.
An actually measured zero CPU is shown as zero; absent values remain unavailable.
Both session and view generations fence callbacks. Resume/login, expiry and
confirmed logout clear the complete owner-scoped cache. A view's late error cannot
change a subsequent view or owner.

Contract provenance: only `resource_health.rs` and its module/export registration
from coordinator `0d56e85b035c2753875e947d5982ec821d0dad96` are imported. Coordinator
owns server route integration. Rust state tests and synthetic Node bridge tests do
not establish HTTP integration, mounted-browser rendering, or live measurement
acceptance. Those remain separate release evidence. Stop and steering are unchanged.
