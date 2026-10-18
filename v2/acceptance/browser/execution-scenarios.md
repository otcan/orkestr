# Prepared execution browser scenarios

`execution-scenarios.mjs` is an additive scenario module for the managed browser
harness at commit `18e920fb0e78f26a1fbfc913a66af6c8b1cc179f`. It has not been run
against a qualified new server/UI pair. The original read-only browser receipt
is evidence only for its original pair.

The coordinator and browser helper own runner integration, lease acquisition,
artifact qualification. The UI-owned test-only Store fixture driver is included here. This module does
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
- `advanceRevision()`: admit a distinct synthetic followup without claiming it;
  assert the same AwaitingAcceptance run/candidate and increased revision.
- `revokeBrowserSession()`: revoke only the current isolated browser credential
  through the reviewed session operation. Never copy real credentials or change
  another context's state.

All fixture methods must preserve the selected conversation. Fixture setup is
synthetic authority controlled by the harness, not evidence of provider inference,
live interruption, or native session readiness. Use only the assigned isolated
home and ports. The driver is an explicit ignored server integration test, controlled through private
stdio by `fixture-driver.mjs`. Its database must be regular, inside a marked
`orkestr-v2-browser-*` temporary directory, with a synthetic owner. No server route,
direct SQL, provider process or production executable is added. Compile the test
against the registered combined server source: copy `fixture-driver-test.rs` to
`v2/apps/server/tests/browser_fixture_driver.rs` in the isolated candidate checkout
(the relative module path is intentional). The UI branch does not import backend
implementation prerequisites merely to register this test. Use the required locked/offline
wrapper and `-p orkestr-v2-server --test browser_fixture_driver --no-run`. Pass the
resulting executable, database, username, conversation and isolated context to
`fixtureDriver`. Hash the executable and both driver files in the run receipt.
Close the driver before deleting the isolated database. Syntax checking does not
satisfy any browser case.

The scenarios check reload discovery from actual execution GET, a server-committed
acceptance whose response is deliberately dropped and retried with the identical
request, duplicate receipt identity, native stale-revision refusal, external
payload removal without revision/ref changes, local deletion racing a delayed
pre-deletion read, truthful disabled Stop, draft preservation, and revocation.
Response fault injection uses CDP on the owned page only and never supplies fake
success bodies. The mounted stale-revision case pauses the actual acceptance
request, calls `advanceRevision()` (ordinary distinct message intake), verifies
unchanged run/candidate with a newer revision, then forwards the original request.
It requires actual HTTP 409, explicit review before refreshed acceptance, a new
request key and preserved draft. This scenario remains unexecuted until the new
qualified pair is run.

The helper must also retain the original harness's composer/render responsiveness
measurements for the new artifact. This module does not transfer the old 10,000-row
measurement to the new bundle. Revocation is last because it intentionally ends
the authenticated session. Unsent drafts are intentionally discarded on full page
reload; the reload case begins draft-preservation checks only after reload.

Local driver validation used the combined integration source `820fc2f0` in an
isolated checkout: two executable Store/protocol tests passed; the explicit
interactive driver test is ignored by default and is exercised as a child by the
protocol test. This does not execute the JavaScript factory or any mounted browser
scenario. Rebuild and qualify the fixture executable against the final registered
server source before browser use.
