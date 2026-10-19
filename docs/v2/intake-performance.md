# Isolated backend performance checkpoint

`v2/acceptance/intake_performance.py` measures the ordinary Rust server through
loopback HTTP with synthetic credentials and data. It never connects to an
existing server, runs a provider, or reads a deployment home. Only its own child
is signalled. Linux is required for this process probe.

The harness copies the supplied executable into a new private evidence directory
and verifies its required SHA256 before execution. Readiness must come from that
child's post-bind startup output, including its isolated home and listening port.
HTTP disables ambient proxies and redirects. The child receives only an isolated
HOME, locale and explicit V2 configuration. State and credentials are temporary;
the pinned executable, redacted configuration and evidence remain private.

The fixed workload is bounded:

1. Fifty excluded warm-up admissions, then 300 measured admissions to one
   conversation. Ten synchronized clients each keep at most one request in
   flight. Each fresh request must return 202 and a valid unique receipt.
2. Exactly 10,000 small synthetic messages enter a separate conversation through
   the ordinary HTTP admission route. These setup timings remain in raw evidence
   but are excluded from the intake percentile.
3. SIGKILL the owned process, reopen its private store and read back every
   acknowledged message through bounded pages. Identity, sequence and text must
   match the receipts. This checks process-restart persistence, not hardware
   power-loss durability or provider recovery.
4. After restart verification and five excluded warm-up reads per position,
   measure 100 sequential 50-message pages at each of the first, middle and tail
   positions. These are warm-cache reads with one client.

Latency starts immediately before HTTP open and ends after bounded response-body
reading and JSON decoding. Each request uses a fresh TCP connection. Percentiles
use the nearest rank: sort all attempted durations, then select the one-based
rank `ceil(p * N / 100)`, without interpolation. Failed HTTP/transport/protocol
attempts remain in raw samples and percentile input; any failure or missing
sample prevents passing. The strict comparison is p95 **below** 250 ms for
admission and below 2,000 ms for each local history-page position.

This is a closed-loop load model, not a fixed arrival rate or a queue-saturation
test. It cannot establish normal-access/browser thread loading, input-to-paint,
provider response time, busy-composer behavior, resource-polling impact or Stop
fencing. Those gates are explicitly pending even when the checkpoint passes.
The page threshold comparison does not satisfy the normal-access 2-second gate.

The default wall-time budget is 180 seconds, configurable only from 30 to 300.
A watchdog kills the owned server at the deadline; requests have a five-second
socket timeout and bounded response sizes. Cleanup can add up to ten seconds.
Failed/incomplete runs preserve their attempted samples and cannot pass. A run
must not be repeated just to obtain a better percentile.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/acceptance -p test_intake_performance.py
python3 v2/acceptance/intake_performance.py \
  --binary /private/artifacts/server --binary-sha256 FULL_SHA256 \
  --source-checkout /workspace/orkestr --source-revision FULL_COMMIT \
  --evidence-dir /private/evidence/intake
```

The evidence parent must be owned by the invoking user with mode 0700, without
symlink ancestors. New reports/configuration/raw samples use exclusive mode-0600
files. No tokens, credentials or HTTP bodies are persisted. `report.json` binds
source revision, binary, lockfile, harness, redacted configuration and raw-sample
hashes. The source-to-binary relationship remains caller-attested; hashes do not
prove a reproducible build. `samples.jsonl` preserves warm-up, seeding, readback
and measured phases separately, including statuses and errors.

Exit 0 means this backend checkpoint passed; 1 means measured failure/incomplete
coverage or a threshold miss; 2 means invalid configuration. The report always
sets `full_release_qualified` to false and is not a release-readiness evidence
format. Results belong in private evidence, not public fixtures or this document.
