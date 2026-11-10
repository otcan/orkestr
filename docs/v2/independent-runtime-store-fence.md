# Independent runtime store-fence review

Exact reviewed and executed source:
`1ac5b079abe459c2b7ab260230dfdaae6280a4ad`.
The consumed bridge and containment modules remain test-only. No production
registration or provider execution is approved by this checkpoint.

Source review found no blocker for this bounded increment. StoreFence derives
its immutable admission and scope from the consumed issuer capability. It
rejects scope mismatch and invokes the reviewed ordinary Store synchronous
SQLite fence through spawn/enqueue/flush. Its nested transport error is retained;
stale, expired and revoked durable authority becomes transport refusal.
The store subtree matches Core `4d66e605` exactly.

Independent execution of the unchanged author tests in an exact-source export:

```text
test --offline --locked -p orkestr-runtime --lib execution::tests
4 passed; 0 failed; 18 filtered out
```

The required host wrapper was used with isolated verification target/home.
Source diff check passed. This reruns author cases; it is not independently
authored bridge acceptance. The positive colon namespace case closes the earlier
issuer/transport grammar discrepancy at this exact source.

The two renewal calls race each other. Refused queued flush occurs after renewal;
refused spawn occurs after revocation. Neither test establishes an actual
concurrent flush/revocation race. Pool reopen establishes no reissue under a live
original handle, not new-process recovery. Ordinary seven-window process probes,
metadata-to-execution same-child attachment, live protocol execution and release
readiness remain separate pending gates.

## Registered durable race oracle

Source reviewed: Isolation `4d0ddad6e74bd65f0b84800436110b9e1f67d172`.
Matching registration: Runtime `4e77a068b9e2c4af498f18ec02016392a90cfcfd`.
The oracle file matches exactly; registration adds only its module declaration.
No blocking bounded source finding. The test adapter invokes the actual SQLite
fence; containment additionally checks the supplied scope before its action.

Local authority revoke races enqueue; durable token revocation races a bounded
partial flush. Barriers release contenders together but force neither overlap
nor ordering; both legal serial outcomes are accepted. A later flush must refuse
after revocation. Renewal refusal is deliberately after a completed renewal and
a seven-byte written prefix, not a concurrent renewal/flush test. Another case
uses the actual issued deadline without SQL or clock mutation. Nonreader and
exited-child cases check backpressure/pipe failure and consumed no-reissue.
Cleanup revokes only registered owned groups and bounds reaper completion.
Restoring a synthetic session token is explicit test reauthorization solely to
inspect no-reissue, not automatic credential revival.

These tests do not establish metadata attachment, live-provider behavior or
new-process crash recovery. Independent execution evidence follows separately;
the source author's reported six passes do not supply independent credit.

Independent exact registered-source execution through the required wrapper:

```text
test --offline --locked -p orkestr-runtime --lib containment::tests::durable_races
6 passed; 0 failed; 0 ignored; 22 filtered out; 60.22 seconds
```

The original oracle file was unchanged. These are independently rerun author
cases, not independently authored acceptance. The real expiry wait completed.
