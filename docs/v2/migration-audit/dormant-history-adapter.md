# Dormant published-history adapter and Core dependency

`v2/migration/dormant_history.py` implements deterministic preparation and a
proposed atomic-port adapter for complete published ConversationSnapshot pages.
It is not a registered Core importer or an alternative database/store. Its only
input authority is already-authorized pages; caller supplies distinct source
namespace, target owner and fresh target namespace UUIDs. It performs no I/O.

Preparation invokes the real bounded collector before producing any apply input.
It preserves source scope as provenance (never a target project grant), source
watermark, message order, actor/text and canonical snapshot/message digests.
Target conversation/message UUIDv5 identities are derived under the explicit
target namespace and source namespace. Canonical immutable request bytes bind
mapping version, target owner/namespaces and source digest to the batch key.
No source auth, sessions, provider bindings, outbox, routes or timer fields are
accepted. Historical disposition is exactly HISTORY_ONLY; no runnable admission
conversion exists. Actor strings are preserved, not guessed into runtime roles.
Message text remains potentially sensitive: no privacy scanning is claimed.

Before apply, the adapter reconstructs and revalidates the complete request,
refusing tampered IDs/digests/disposition and extra fields. It makes one proposed
import_dormant_history(token, request) call and requires a complete DORMANT
receipt with exact batch/owner/namespace/digest/conversation/count and positive
revision. Bad/partial receipts cannot become success; uncertain completion needs
Core reconciliation, not guessed rollback or a new namespace retry.

Rollback calls proposed deactivate_dormant_history with exact owner/namespace/
batch and expected imported revision. Only a matching INACTIVE receipt succeeds.
The proposed Core port must atomically refuse changed/delta/shared-reference
cases and retain provenance on deactivation. Idempotent rollback may return the
same inactive revision; replay must not reactivate it. The Python adapter cannot
verify a dishonest port or independently enforce target persistence/atomicity.

## Coordination boundary

A precise additive request was sent to the Core lane: own Store schema and
atomic import/deactivation/readback, authenticate the new target session, require
a fresh target namespace, isolate history from live admission/outbox/runtime,
refuse namespace/digest conflicts and support untouched revision-only rollback.
Core retains registration ownership. The Python method names/receipt shape above
are a **proposal**, not published or accepted Store API symbols. Adapt them to
Core's exact accepted contract before wiring. No source/target credentials are
copied and no real import is authorized.

Eight synthetic adapter tests use a clearly test-only in-memory proposed-port
oracle, covering deterministic preservation/no mutation, replay, untouched
rollback/repeat, inactive replay refusal, changed source conflict, V2-only revision
hold, incomplete/credential input rejection before call, plan/receipt tampering,
partial apply receipt, wrong target auth, empty history and multipage ordering. These are adapter tests, not real
Store import/rollback acceptance. Actual dormant apply, provenance durability,
readback, atomic failure and delta/shared-reference rollback remain **unexecuted**
until Core implements the additive port. Existing stable export integration
cannot close those gaps. Full release migration/rollback is not yet complete.
