# Managed-browser acceptance

This harness exercises the mounted WASM UI against an ordinary V2 server using
a real Chromium cookie jar and rendering loop. It connects to an already managed,
leased browser through CDP and creates one fresh isolated browser context. It
never launches or closes Chrome, inspects existing pages, opens an existing
profile, or visits a production service.

The operator must acquire a free registered browser lease first, refresh it while
the run is active, and release it afterward. The runner consumes a metadata-only
lease receipt; the browser manager remains the authority. Do not put manager
credentials or lease fencing tokens in that receipt. Do not steal another task's
lease. Preparing artifacts does not require holding a browser lease.

## Inputs

Build the ordinary server with default features and the UI using its reviewed
`v2/apps/ui/scripts/bundle.sh`. Follow the host's build wrapper and target-directory
policy. The server must expose authenticated browser sessions, static assets,
`GET /api/v2/resources`, and the conversation execution GET returning 204 when no
observation exists. Stubbed HTTP routes cannot qualify the native-route checks.

Record exact source commits and SHA-256 hashes after building from clean pinned
sources. Hashes prove the chosen bytes stayed unchanged; they are not a substitute
for recording which source produced them. Server and UI source pins may differ,
but that exact pair must be declared and reviewed together.

The provenance JSON has this shape (replace all example values):

```json
{
  "schema_version": 1,
  "server": {
    "path": "/absolute/owned-build/orkestr-v2-server",
    "source_sha": "0000000000000000000000000000000000000000",
    "sha256": "server-file-sha256",
    "features": "default"
  },
  "ui": {
    "path": "/absolute/owned-build/ui-dist",
    "source_sha": "0000000000000000000000000000000000000000",
    "files": {
      "index.html": "asset-sha256",
      "orkestr_v2_ui.js": "asset-sha256",
      "orkestr_v2_ui_bg.wasm": "asset-sha256"
    }
  }
}
```

List **every** bundle asset, including nested generated modules. Inventory changes,
symlinks, mismatching hashes, and an old bundle served by the candidate are refused.
No build or dependency installation happens in this harness.

The metadata-only lease receipt contains:

```json
{
  "acquired": true,
  "desktopSlug": "registered-test-desktop",
  "ownerThread": "owning-project-thread",
  "browserURL": "http://127.0.0.1:9222",
  "expiresAt": "REPLACE_WITH_ACTUAL_LEASE_EXPIRY"
}
```

Use the existing installed Puppeteer module; the optional module argument accepts
its absolute JavaScript entrypoint. The package is already a repository development
dependency. A new output directory is required for each run.

```sh
node v2/acceptance/browser/runner.mjs --provenance /absolute/provenance.json --verify-only
node v2/acceptance/browser/runner.mjs \
  --provenance /absolute/provenance.json \
  --lease-receipt /absolute/lease-metadata.json \
  --puppeteer-module /absolute/installed/puppeteer/entry.js \
  --output /absolute/new-browser-receipt-directory
```

## Scenarios and evidence

- First administrator setup through the real page, browser login, HttpOnly
  SameSite cookie, and cookie-based reload/resume.
- Typing while an execution read is held, then continued polling; no browser
  Bearer or CSRF header on GETs. Drafts survive tab navigation and the UI's
  reconnect action. Ordinary page reload intentionally discards unsent drafts.
- 10,000 synthetic messages durably admitted through the isolated server's machine
  API with four bounded seeding requests in flight. The History view renders 100
  rows and requests only the selected pages. First/next-page and composer actions
  must finish under two seconds; the measured animation-frame gap must stay below
  250 ms in the foreground test page. Timing evidence describes that run and host.
- Host resource reads fail visibly without invented zeros, then display actual
  measurements from the temporary server. A frozen native response is replayed
  to exercise real monotonic aging and tab remount; stale values become unavailable.
  This is deliberate response fault injection, not evidence of fresh measurements.
- A real logout request is held while a resource read reports expired authority.
  Reauthentication remains fenced until the logout completes and the server cookie
  is revoked. The same binary then starts with a separate empty synthetic namespace
  at the same temporary origin; the new owner's draft and resource cache are empty.

Credentials and tokens are generated in memory for temporary synthetic state.
The server receives an explicit environment allowlist with no provider credentials,
legacy state, or profile paths. No provider inference or real message delivery is
requested. Controls still unavailable in the product remain unavailable.

The receipt records source/server/bundle hashes, browser version, phase timings,
bounded counters, failures without raw credential-bearing diagnostics, and cleanup.
Screenshots contain only the owned synthetic page. The owned context and server
are closed, and temporary state is removed even on failure. The shared browser
stays running. The operator must independently release the managed lease.

An unavailable managed browser or an unqualified bundle is a blocker for the
actual-browser result. Syntax checks, source unit tests, and fake responses alone
must not be reported as browser acceptance.

## Optional completion and payload scenarios

`--execution-fixture /absolute/fixture-receipt.json` adds real rendered completion
and payload checks after the original scenarios. The server and controls-enabled
UI must share the receipt's exact `product_source`. The receipt pins the separate
test-only Store driver's executable and source modules; the runner verifies their
hashes before loading or executing them. The driver is never part of the server
and receives only the marked, newly created second synthetic owner's database.

The additive cases reload a durable completion candidate, drop an actual committed
acceptance response, retry the identical request, and require the identical receipt.
For the mounted conflict path, the browser's real acceptance request is held before
delivery while a legitimate fixture admission advances the revision. The server
returns 409; the UI must retain the draft and require an explicit updated review
before it can submit a new request key. The candidate must be accepted before the
fixture opens the next run for removable progress output. Payload tombstones,
late pre-deletion responses, session revocation and unavailable Stop are checked
through the real page and ordinary HTTP routes. No successful response is invented.

These are synthetic Store authority tests, not provider execution or verified
interruption. The receipt records that scope, the fixture pins, elapsed time and
owned-child cleanup. Fixture authority lasts 60 seconds per claimed run; expiry
is a failure, never an excuse to bypass authority checks.
