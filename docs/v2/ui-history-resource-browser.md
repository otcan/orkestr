# Current-pair history, resources and busy-composer browser checks

These connect-only harnesses require an already acquired registered desktop lease and immutable ordinary-server/web provenance. They create isolated browser contexts and synthetic owner/server state, never launch Chrome, access existing pages or authenticate a real provider. Pair verification checks the native executable and complete UI inventory, then the history runner verifies the bytes served by the ordinary server. No product source is substituted.

`history-runner.mjs` reuses the previously reviewed browser history/resource scenarios. `history-support.mjs` and `history-scenarios.mjs` retain the measured cursor/limit/size instrumentation from the earlier mixed-execution harness. The original history assertion remains two or three reads, each exactly 100 messages and at most 64 KiB. It records the response metadata **before** asserting, retains 100 rendered rows, checks animation-frame/input latency, and seeds 10,000 messages through ordinary authenticated intake. The historical unexplained page-count failure remains unexplained; a later passing measurement is not its diagnosis.

The resource checks first render an intercepted unavailable response without zero values, then require genuine measurements from the ordinary host-aggregate endpoint. Replaying a captured genuine sample must become stale using real elapsed time, remain stale through remount, and never expose prior owner values after logout/session replacement. The fault responses and cached replay are explicitly harness injections; the native measurement is not synthetic CPU/RAM data.

`history-busy-runner.mjs` verifies the exact reusable Worker fixture harness at commit `8a3f91a876a40de00e1b42c879915e9734e58027`, together with the fixture modules at the candidate's own source commit. It uses the existing synthetic ordinary Deep peer, cookie login and real execution polling. Cold/warm authenticated reloads happen while the peer is Running; both reloads record actual WASM response/cache/revalidation metadata. Here “warm” means a repeated authenticated open in the same initialized browser/context; it does not assert an HTTP cache hit or measure browser launch time. Native Ctrl+A selection is checked against the complete textarea length before replacement. Repeated edits over 30 seconds must remain exact, with bounded input and animation-frame delays; the same Deep run must still be Running at the end. No provider inference or claim of completion is involved.

Example arguments (provide private artifact/lease paths outside the repository):

```sh
node v2/acceptance/browser/history-runner.mjs \
  --provenance /tmp/synthetic-acceptance/provenance.json \
  --lease-receipt /tmp/synthetic-acceptance/lease.json \
  --puppeteer-module /opt/browser-tools/puppeteer.js \
  --output /tmp/synthetic-acceptance/history-run
node v2/acceptance/browser/history-busy-runner.mjs \
  --provenance /tmp/synthetic-acceptance/provenance-with-fixture.json \
  --lease-receipt /tmp/synthetic-acceptance/lease.json \
  --puppeteer-module /opt/browser-tools/puppeteer.js \
  --fixture-harness /tmp/synthetic-acceptance/reviewed-worker-harness \
  --output /tmp/synthetic-acceptance/busy-run
```

Use a fresh output directory per attempt. Preserve unsuccessful receipts and source hashes. The caller owns lease acquisition, heartbeat and release; runners close only their contexts and owned synthetic processes. Host load, synthetic peers and a single registered browser do not establish production latency, soak, real-provider performance, release-candidate readiness or deployment acceptance.
