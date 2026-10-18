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

Initial source artifact only. Syntax validation and CLI help do not constitute
server execution. The three ordinary cases and all downstream production cases
remain unexecuted at this checkpoint. Core/Runtime have been asked for the minimal
public ordinary setup/route and exact source handoff; current runtime ac595343 is
explicitly fixture-only. No production readiness or release acceptance is claimed.
