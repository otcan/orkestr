# Core chat beta browser acceptance

This is a narrow harness library, not an activated acceptance runner. Imports do
not start a server, browser, provider or desktop lease. A protected operator
entrypoint must bind the final reviewed server/UI pair and current desktop lease.
Public source contains no deployment addresses or account configuration.

`browserSmoke` is a callable ordinary login/reload/draft/resource runner; it has
no command-line activation and requires reviewed pair/lease adapters and an
already owned context. It closes that context and joins its work within the
short session budget. The outer operator still owns connection/helper/lease cleanup.
`attachmentRoundtrip` is a separate short session using the same ten-byte
binary fixture and completion/read/delete proof as the prior qualified flow.
Its `savedBytes` implementation is copied unchanged (SHA-256
`0bcc4d6474f8efbc54f5886fd5acf497422966d0f157251913c58e7a464a09f6`).
`captureControls` passively retains only bounded receipts for the selected
conversation's five control routes; raw JSON remains in memory and must be
discarded after assertions. `window-evidence` checks the published window DTO:
exact admitted input binding, unchanged limits on joins, immutable retries and
unchanged Stop-held input provenance. These are observation checks, not grants.

The initial modules provide enabled-label readiness before a single action,
ordinary owner login/reload, route-remount draft checks, visible host CPU/RAM,
normal navigation/request timing, closed diagnostics, independent cleanup steps,
and a separate natural-time continuity observer. They do not yet claim mounted
beta acceptance. Chat/Progress/acceptance/Stop/held-input/post-Stop/Steer checks
use the existing ordinary execution/control DTOs plus the published window DTO.
`browserChat` performs four fixed ordinary input actions, at most one Steer,
one Stop and two explicit acceptances through the UI. It requires real text in
the selected Deep output panel, scopes same-labelled controls away from Fast,
and retains held-input provenance through post-Stop work, acceptance and reload.
An advertised-false Steer sample is reported as currently unavailable; it does
not prove that the provider lacks steering. A required Steer must reach an exact
native acknowledgement, not a reservation or ordered queue fallback.

Window generation observations follow Core `2b9227da1753629ae04d0a170c6c659842c656e3`:
integers below 2^53, including a same-window join at the last safe generation;
creating an overflowing successor fails. No window is opened automatically by
this harness: the matching mounted UI must perform the separate admission after
its ordinary message receipt. The exact service/pair must be reviewed before any
actual invocation. Source tests alone do not qualify the composed UI/runtime.

## Required private composition

- Connect to an existing registered browser only after acquiring its canonical
  lease. Create only the run's own context and preserve existing tabs/processes.
- Use the reviewed idle/framing helper: waiting for the first frame byte must
  not consume the one-second remaining-header/body deadline. Retain its overall
  120-second lifetime for each short functional download session.
- Use the already qualified LocalManager constructor timeout validation, with a
  fixed trusted `operationTimeoutMs: 6000`; default 100 remains for other uses.
  Timeout does not grant cleanup success. Pending and late allocations remain
  owned until joined or explicitly reported unknown.
- Use the reviewed context adapter that skips redundant detach only when the
  exact owned session reports `detached === true`. Context-close, pending-join
  and live-session detach errors remain failures.
- Use the existing exact saved-byte adapter: recorder before click, completion
  receipt, bounded byte/hash comparison, exact-owned delete and absence proof.
  A Blob, HTTP response or browser download event alone is insufficient.
- Pin the complete actual executable closure before startup, including cached
  Python bytecode and native libraries when Python is used. Root-controlled
  nonwritable server/UI copies close mutable verification-to-use paths.
- Recheck the normal access route serves the selected exact bundle. Use a fixed
  designated loopback port for synthetic servers; readiness must belong to the
  actual spawned child. An occupied port fails without touching its owner.
- Cleanup closes only owned contexts, connections, helper, private gate,
  temporary configuration and the run's lease. The always-on beta service and
  shared browser process are not cleanup targets. All cleanup steps are attempted;
  failed or timed-out steps stay unknown and prevent a successful receipt.

## Boundaries and evidence

Synthetic cases and a separately authorized real-Codex case have distinct
receipts. No fixture may silently select a provider or trigger account resolution.
Keep one owner/conversation per real attempt and explicit intake/control budgets.
An acceptance receipt is not model completion; an interrupt ACK is not Stopped.
Stop must retain the earlier held input while only new post-Stop intent executes.
Unsupported Steer must be visible as unavailable, never reported as passed.
Browser status and payload proofs are not independent process-tree evidence.
The protected operator must additionally verify native cleanup and durable
input/run lineage; `browserChat` explicitly retains those postcheck requirements.

`observeContinuity` uses monotonic real time, at least fifteen minutes, no missing
observation interval over thirty seconds, and at most 96 samples. Its concrete
trusted adapter must verify health, served build and service identity; it does
not invent a window API. Lease heartbeat is required if a browser remains owned.
The privileged download helper is closed before this separate service observation.
Unit tests use simulated timestamps only to test the oracle and provide no
service-continuity qualification.

Current draft behavior is checked across route remount and reconnect. The existing
product intentionally discards an unsent draft on a full page reload; this harness
does not relabel that behavior as persistence. The final beta requirement and
matching UI behavior must be declared before the mounted run.

Run the focused source tests with:

```sh
node --test v2/acceptance/browser/beta/*.test.mjs
```

The full Memory race matrix is outside this beta milestone.
