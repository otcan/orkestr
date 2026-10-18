# Independent Worker browser acceptance

This harness connects to an existing registered, leased CDP desktop. Every case
creates a fresh browser context and temporary ordinary server namespace, and uses
the source-pinned fixed synthetic task peer through the real broker and HTTP
routes. It never starts Chrome, uses an existing profile page, invokes a real
provider account, or changes production state.

Use a reviewed matching server/UI pair with execution controls enabled. Extend
the existing browser provenance JSON with:

```json
{"fixture":{"path":"/absolute/exact-source-export","repository":"/absolute/source-repository","source_sha":"EXACT_SAME_SERVER_COMMIT"}}
```

The fixture verifier compares every imported helper, peer and broker source file
against that exact immutable Git object with replacement/graft configuration
disabled. The existing provenance verifier pins every UI asset and server byte;
each temporary server must serve those same bytes. No build occurs in the runner.

```sh
node v2/acceptance/browser/worker-runner.mjs --provenance /absolute/pair.json --verify-only
node v2/acceptance/browser/worker-runner.mjs \
  --provenance /absolute/pair.json \
  --lease-receipt /absolute/current-lease-metadata.json \
  --puppeteer-module /absolute/installed/puppeteer-entry.js \
  --output /absolute/new-private-receipt-directory
```

The optional `--cases` accepts a comma-separated subset of `tasks,stop,ack-only,held,logout`
for a justified targeted follow-up. Preserve original failures; a new artifact
needs new provenance and a fresh output directory. The operator acquires,
heartbeats and releases the lease through the browser manager.

The cases cover:

- Task draft editing during a held real read; actual lost-create-response retry
  after a tab remount with identical intent/receipt and one Worker turn; readable task history,
  collapsed provenance and a real payload tombstone; conversation and task draft
  behavior across tab remounts. Draft loss is reported, never silently excused.
- Selecting an independent Worker, real native Stop, exact retry after losing the
  committed response, and unaffected sibling/parent. ACK-only cleanup remains
  cancellation requested; no local kill is treated as provider terminal proof.
- Older queued input remaining held after parent Stop and actual browser reload,
  readable limitations instead of invented previews/timestamps, and disabled
  unavailable held-input actions.
- Actual browser logout while an authorized task response is delayed; releasing
  that response cannot repopulate the signed-out view, and reload requires login.

No provider namespace PID is used as a host signal target. The fixture reuses the
owned host identity observer, closes its exact Popen server and verifies native
identities/scratch disappear. The runner closes only its contexts and disconnects
from CDP; it never closes the managed browser. Failure receipts and screenshots
contain only the private synthetic namespace, with hashes instead of raw errors.

The fixture has a 90-second controller limit; its existing native peers retain
their shorter 40-second limit, so cases use separate namespaces. Ordinary HTTP
unit tests, fixture smoke tests and source review do not count as actual-browser
acceptance. These cases do not qualify real provider execution, Worker recovery,
durable timers, large-history performance or production latency.
