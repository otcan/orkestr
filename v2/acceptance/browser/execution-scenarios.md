# Prepared execution browser scenarios

`execution-scenarios.mjs` is an additive scenario module for the managed browser
harness at commit `18e920fb0e78f26a1fbfc913a66af6c8b1cc179f`. It has not been run
against a qualified new server/UI pair. The original read-only browser receipt
is evidence only for its original pair.

The coordinator and browser helper own runner integration, lease acquisition,
artifact qualification and the synthetic Store fixture driver. This module does
not acquire a lease, launch a browser/server, install tools, or enable controls.
Only run it after registering matching exact server and controls-enabled UI
artifacts. Existing runner asset inventory verification, isolated browser context,
network restrictions, credential handling, abort signal, receipt and cleanup rules
remain mandatory. Include this module's hash in the receipt.

Call `executionScenarios({page, fixture, report, signal})` after authenticating a
fresh synthetic owner in the owned context. The fixture driver must expose:

- `completed()`: commit a new ordinary synthetic run and CompletedProposal through
  reviewed Store operations in the selected conversation. Return exact committed
  `conversation_id`, `run_id`, `completion_event_id`. Do not manufacture HTTP
  responses or change SQL rows directly. Canonical execution GET must expose the
  same acceptance candidate and AwaitingAcceptance status.
- `progress()`: commit a fresh removable progress payload through the reviewed
  adapter, with a valid selected status progress reference. Return exact
  `conversation_id`, `payload_id`, and synthetic `text`.
- `revokeBrowserSession()`: revoke only the current isolated browser credential
  through the reviewed session operation. Never copy real credentials or change
  another context's state.

All fixture methods must preserve the selected conversation. Fixture setup is
synthetic authority controlled by the harness, not evidence of provider inference,
live interruption, or native session readiness. Use only the assigned isolated
home and ports. A matching fixture driver remains a prerequisite; syntax checking
this module does not satisfy any browser case.

The scenarios check reload discovery from actual execution GET, a server-committed
acceptance whose response is deliberately dropped and retried with the identical
request, duplicate receipt identity, native stale-revision refusal, external
payload removal without revision/ref changes, local deletion racing a delayed
pre-deletion read, truthful disabled Stop, draft preservation, and revocation.
Response fault injection uses CDP on the owned page only and never supplies fake
success bodies. The stale-revision case currently verifies native HTTP/state
refusal; mounted UI conflict/review rendering requires an additional coordinated
request-stage revision-race driver and must be reported separately until run.

The helper must also retain the original harness's composer/render responsiveness
measurements for the new artifact. This module does not transfer the old 10,000-row
measurement to the new bundle. Revocation is last because it intentionally ends
the authenticated session. Unsent drafts are intentionally discarded on full page
reload; the reload case begins draft-preservation checks only after reload.
