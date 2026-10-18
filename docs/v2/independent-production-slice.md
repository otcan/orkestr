# Independent ordinary production-slice gate

This gate is separate from the release-readiness validator and from all fixture
acceptance. `v2/acceptance/production_slice.py` invokes an actual server binary
with fresh synthetic homes, an environment allowlist and owned child handles.
No fixture supervisor, private authority constructor or existing provider session
is used. The current explicit three-case suite covers ordinary HTTP machine auth
namespace/Origin refusal, concurrent duplicate/conflicting intake, durable receipt
followed by owned SIGKILL/restart, and SSE cursor replay. It reuses the independently
authored intake process support; inherited cases outside the explicit list do not
run or count toward this slice. These are intake gates, not provider execution.

Run with absolute `--binary` and `--home`, a full `--source-head`, and assigned
verification `--port`. Build only via the assigned v2-cargo wrapper, isolated
verification target and home. Preserve the exact wrapper command and build source
alongside the emitted binary SHA256. A supplied source SHA is attribution, not
proof that an arbitrary binary was built from it. JSON emits executed counts and
pending dependencies separately. The runner deliberately exits 1 while the full
production slice remains incomplete, even if all currently executable cases pass.

## Next ordinary implementation handoff

Core owns ordinary authorization and persistence; Runtime owns real protocol
adapters. The published fixture composition does not provide these facilities.
The independent harness requires an exact reviewed source pin and public setup
that establishes owner/project, independent fast/deep persistent sessions and
readiness, then an owner-authenticated ordinary run/cancel route. Protocol test
children must be started and stopped through owned handles under the adapter's
actual transport. No credentials or private handle reconstruction are acceptable.

After that handoff, add actual ordinary paths in this order:

1. Concurrent admission/replay and authoritative role/project isolation, proving
   exactly one durable dispatch winner before protocol I/O.
2. Lease generation CAS and stale/forged authority refusal with unchanged scoped
   state; independent fast/deep/worker busy behavior.
3. Owned-process kill before durable commit and after consume/commit before reply,
   followed by genuinely new-process reopen. Unknown outcome must quarantine and
   never restart merely because an acknowledgement was lost.
4. Exact cancellation idempotency/control fence, completion-before-stop race,
   retained unpersisted observation and canonical Stopped receipt; no fabricated
   success or delivery acknowledgement.
5. Browser cookie/CSRF interaction, session revocation and mixed replay through
   actual same-origin client, separately from machine Bearer intake.

Read-only state oracles must be scoped to synthetic owned data, query-only in one
transaction, with handles closed before cleanup. Request narrow public fault
controls only when existing protocol synchronization cannot identify the required
boundary. Keep real-provider/session tests distinct from synthetic protocol tests.
Performance, current workflow parity, migration and rollback remain additional
release gates; this document does not grant cutover or replace their validator.

## Current evidence

Independent execution completed against approved integration
`c8358b7fdd6fadbd3853a9067157f4c3876d394e`, using a clean exact-head `git archive`
of `v2/` in an owned verification source directory. From that directory:

```sh
v2-cargo build --offline --locked -p orkestr-v2-server
python3 v2/acceptance/production_slice.py --binary <absolute-built-server> \
  --home <owned-fresh-case-parent> --source-head c8358b7fdd6fadbd3853a9067157f4c3876d394e \
  --port 47140
```

The build used the assigned wrapper, verification target and isolated home.
All three selected ordinary-server cases passed in 3.206 seconds, zero failures
or errors. The harness exited **1**, intentionally: seven downstream gate groups
remain pending and `production_slice_accepted` is **false**. No fixture case ran.
The exact built binary SHA256 was
`1926e962dc3bbe495417af79d17049b1ef158c04814c98074e5d68b9c803d757`.
Each case spawned its own server and synthetic credentials; cleanup killed/reaped
only its owned child. The duplicate case required a durable 202 before SIGKILL,
then reopened the same home and verified the original receipt and four atomic
intake counts. This proves intake restart, not provider recovery or lost transport
acknowledgement.

An earlier run against exact Core454b40d7 passed the same three cases in 3.934
seconds. The approved integration build produced the same binary hash; source diff
between those heads was empty for server/application/contracts/store. The c835
result above is the credited integration execution, not inferred from the first
run. No Cargo dependency resolution or lock edit occurred.

Core/Runtime have been asked for the minimal public ordinary setup/route and exact
source handoff. Runtime confirms ac595343 remains fixture-only. Ordinary dispatch,
protocol-provider execution, lease/unknown-outcome/cancellation, browser session
interaction and full parity/performance/migration/rollback remain pending. The
release-readiness validator and its evidence files were not modified. This is no
production readiness or cutover approval.

Coordinator independent rerun at build source `c8358b7fdd6fadbd3853a9067157f4c3876d394e`: all three selected ordinary-server probes passed in 3.399 seconds. Binary SHA-256: `c1c737937733bd8dd91ec829b41686d92f840bc54dd2c7a2593722c8021a1c28`. The harness exited 1 as designed with seven downstream groups pending and `production_slice_accepted: false`. This rerun does not establish ordinary provider execution.
