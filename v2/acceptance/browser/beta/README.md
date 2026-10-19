# Core chat beta browser acceptance

This is a narrow harness library, not an activated acceptance runner. Imports do
not start a server, browser, provider or desktop lease. A protected operator
entrypoint must bind the final reviewed server/UI pair and current desktop lease.
Public source contains no deployment addresses or account configuration.

`browserSmoke` is a callable ordinary login/reload/draft/resource runner; it has
no command-line activation and requires reviewed pair/lease adapters and an
already owned context. It closes that context and joins its work within the
short session budget. The outer operator still owns connection/helper/lease cleanup.
Within that same smoke phase, `sampleProtectedReadiness` performs one reload with
only the owned page's HTTP cache disabled, then ten ordinary warm reloads. It
reports the two sample sets separately, including each `n`, all elapsed values,
and nearest-rank warm p95 (with ten samples this is the maximum). The single
cache-disabled sample has no reported percentile and is not a claim about cold
DNS/TLS or server startup. Each sample ends only after composer rendering plus
authenticated owner/configured-conversation checks. Lease and abort checks fence
each navigation; failures restore the page cache and cannot start another sample.
These protected-route timings are separate from provider/chat latency and the
later loopback continuity observation. No shared browser cache is cleared.
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

After each acceptance and full reload, `accepted-results` reads the bounded
owner-scoped result projection and binds the exact run, completion event,
acceptance event and canonical payload. The matching Accepted replies article
must carry those identifiers and render the exact referenced text. A current
Provider output panel, an unrelated result or an API completed phase alone
cannot pass. This uses accepted-result provenance, not an invented chat message.
The DOM contract is UI `5d26b99eb9b60e6b3dbc51a3cb45ed82bc912c13`:
article `data-run-id`, `data-completion-event-id`, `data-acceptance-event-id`,
`data-payload-id`, and a `pre[data-accepted-output="true"]`. Accepted history
uses the owner-scoped canonical store after window retirement; it does not
require a remaining live execution handle.

`browserPostWindow` is a separate short one-input phase after the private
operator's 915-second passive observer. It requires the exact closed predecessor,
the unchanged held row and both prior accepted replies; only then may its one
ordinary Send and Start work create a fresh window. It verifies the fresh run,
third explicit acceptance and restored final reply. The earlier four-input chat
runner is not reused and its fresh-owner precondition is not weakened.

The successful one-input report also exports an observation-only handoff with
its new window/generation, all three accepted-result references, and the unchanged
held row. It does not assert retirement, process cleanup or a service restart.
A separate reviewed operator may use the closed `post_service_restart` purpose
only after independently proving clean retirement and new service identities.
That purpose requires exactly those three prior results and a closed predecessor,
performs one input/acceptance, and checks all prior replies again after reload.
The original `post_continuity` purpose still requires exactly two prior results;
neither accepts an arbitrary phase, prior count or budget. Service control and
the prior-evidence review remain outside this browser library.

Window generation observations follow Core `2b9227da1753629ae04d0a170c6c659842c656e3`:
integers below 2^53, including a same-window join at the last safe generation;
creating an overflowing successor fails. No window is opened automatically by
this harness: the matching mounted UI must perform the separate admission after
its ordinary message receipt. The exact service/pair must be reviewed before any
actual invocation. Source tests alone do not qualify the composed UI/runtime.
The focused shell uses Settings → Assistant for draft remounts. Login and reload
also require `/api/v2/beta` to select the same configured conversation as the
fresh owner's session. The driver clicks Start work or Add to current work only
after observing that exact ordinary input receipt; a rejected intake never
proceeds to admission.

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
