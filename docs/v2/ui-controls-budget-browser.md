# Matching steering and Worker-budget browser acceptance

The connect-only harness targets immutable product source `1d9674b29ed547f4a0cf5530a261aba9450263a1`, default ordinary server SHA256 `c998c4ca8197cbc2bdc4d84550d1a5df88f2bdd1e325ab278ccede5f5aa97a86`, and web inventory SHA256 `f34bdc77bef1461e93dabbafb1f62c83c014e310d1a69a325af85ccb9716a320`. Both retained identities are `2.0.0-dev` at that source. The later task-row copy change is excluded.

Fourteen checks passed across three fresh synthetic owner/server/browser contexts: seven budget checks, four steering checks and three conflict checks, including three protected-cookie logins. All served asset hashes were verified before browser interaction. There were zero page errors or external requests.

Budget cases use actual owner task creation: default omission, explicit 60000/300000/900000 milliseconds, and unchanged 30000-millisecond initial lease. A lost committed five-minute response is retried with the identical complete request and identical receipt after navigation/remount, despite an edited fifteen-minute next draft. The next draft and same-scope conversation draft survive. Logout clears private task state; reauthentication resets the task choice to default. The current read DTO supplies no effective saved deadline, so this gate makes no deadline-display assertion or host-permission inference.

Steering uses the unchanged broker with its source-pinned synthetic native protocol peer. The UI requires advertised Running steering capability. A lost committed response retains the entire original text/run/key/projection/control tuple; editing the next text does not change retry. Actual delivery progresses to acknowledged while the run remains Running, and the mounted notice explicitly denies completion. The stale-control case holds the real outgoing request, releases an ordinary correlated native completion proposal, observes the changed control revision, then releases the original request: actual HTTP 409 requires explicit review. Once the UI's own status poll observes Awaiting review, a new Steer remains disabled. Logout clears steering text/state.

## Preserved unsuccessful evidence

Initial attempts are retained, with no product asset changes. The first budget driver's late Puppeteer response-body lookup failed after a successful fourth request; the successor captures the original real response at the CDP response barrier. The first steering check queried delivery before the asynchronous native acknowledgement; the successor waits on the actual private status before checking the mounted acknowledgement. The initial conflict assertion demanded disabled controls before the UI's own poll learned of completion; the successor waits for that poll. A second budget oracle incorrectly expected same-owner conversation drafts to be deleted on logout, contrary to the existing explicit product behavior; it now checks retention of that correctly scoped draft and clearing of task/steering state. None of these corrections changes request, receipt, HTTP status or owner-budget expectations.

The accepted steering case is in the second attempt; budget and conflict are in the third. Receipts bind each executed harness version independently. They are not represented as one all-cases run. All owned contexts, isolated server/native trees and temporary state were cleaned after each attempt. The registered browser lease was released and the original managed browser remained healthy. No production authentication, real provider, outbound message, RC, deployment or soak qualification is claimed. Earlier browser receipts keep their original attribution.

## Reproduction

`control-budget-materialize.py` extracts ordinary fixture/broker source from the exact product commit and only three reusable browser helpers from reviewed harness `8a3f91a876a40de00e1b42c879915e9734e58027`. It overlays the authored runner/fixture/artifact/scenario modules in a new private directory. It does not build, install tools, launch Chrome or acquire a lease.

```sh
python3 v2/acceptance/browser/control-budget-materialize.py \
  --repository /path/to/checkout --pair /private/paired-artifacts.json \
  --output /tmp/synthetic-controls-acceptance
node /tmp/synthetic-controls-acceptance/harness/worker-runner.mjs \
  --provenance /tmp/synthetic-controls-acceptance/provenance.json --verify-only
node /tmp/synthetic-controls-acceptance/harness/worker-runner.mjs \
  --provenance /tmp/synthetic-controls-acceptance/provenance.json \
  --lease-receipt /private/registered-lease.json \
  --puppeteer-module /path/to/existing/puppeteer.js \
  --output /tmp/synthetic-controls-acceptance/run-01
```

The caller must first acquire and later release the registered desktop lease. The lease receipt includes `browserURL`, `desktopSlug`, `ownerThread`, `acquired: true` and a future `expiresAt`. The runner connects only, creates fresh contexts, blocks nonlocal requests, hashes executable/assets/helpers, bounds fixture authority and closes owned processes/contexts. Materialization plus verify-only, Python syntax, JavaScript syntax and diff checks pass separately from actual browser evidence. No product source, backend policy, root manifest or lock changes accompany this harness.
