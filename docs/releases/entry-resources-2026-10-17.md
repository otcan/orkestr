# Entry performance and system resources

The instance shell now loads optional system, timer, WhatsApp and version data
after the conversation list is ready. Each optional response is applied
independently and has a bounded wait. Pairing, coding-agent readiness and
attachment-encryption initialization remain on the required path. Independent
setup reads run concurrently, and existing instance-context reads no longer
wait for the canonical-reference mutation lock.

Administrators can open **System** in the primary navigation to see CPU, RAM,
disk and Orkestr process memory. Samples refresh every 15 seconds while visible;
errors retain the timestamp of the previous sample. Process details load on
demand. Instance screens retain their own routes even when a conversation was
previously selected. Bundled static assets permit private conditional caching;
HTML and API responses remain `no-store`.

This is a code-only release with no state migration. The release branch starts
from `61684353`; deployment is limited to the configured local instance. Other
feature branches are outside this train.

Validation selected for these surfaces:

- `npm run build`, `npm run web:verify-static`, and `npm run launcher:verify-static`.
- Entry/resource behavior tests cover delayed and failing optional requests,
  required pairing/encryption gates, zero/missing readings, stale samples,
  overlapping polls, component teardown and instance navigation.
- Static-asset HTTP tests prove conditional requests return an empty `304`,
  while HTML, missing-asset fallbacks and API responses remain uncached.
- Instance-config tests hold the mutation lock while reading context and also
  cover concurrent first-use identity creation. Existing connector, security,
  canonical gateway, static UI, wizard and interface suites pass.
- `npm run smoke` and `npm run oss:boundary-check`.
- A registered browser displays the candidate against read-only live data;
  desktop and mobile layouts are checked before activation. Existing browser
  tabs are preserved. Mutating UI requests are blocked in the verification tab.

Two test adjustments were needed: the version request assertion now follows its
extracted loader, and the conditional-fetch test explicitly uses revalidation
semantics instead of the HTTP client's implicit unconditional cache mode.
Real WhatsApp sends, OAuth changes and tenant deployment are outside this change.
Exact-commit CI and activation evidence are retained by the release deployer.
