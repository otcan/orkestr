# Core chat beta browser acceptance

This is a narrow harness library, not an activated acceptance runner. Imports do
not start a server, browser, provider or desktop lease. A protected operator
entrypoint must bind the final reviewed server/UI pair and current desktop lease.
Public source contains no deployment addresses or account configuration.

`browserSmoke` is a callable ordinary login/reload/draft/resource runner; it has
no command-line activation and requires reviewed pair/lease adapters and an
already owned context. It closes that context and joins its work within the
short session budget. The outer operator still owns connection/helper/lease cleanup.

The initial modules provide enabled-label readiness before a single action,
ordinary owner login/reload, route-remount draft checks, visible host CPU/RAM,
normal navigation/request timing, closed diagnostics, independent cleanup steps,
and a separate natural-time continuity observer. They do not yet claim mounted
beta acceptance. Chat/Progress/acceptance/Stop/held-input/post-Stop/Steer checks
must use the concrete reviewed Core/Runtime contract when it is available.

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
