# Runtime supervisor context proposal

Status: reviewed design constraints, not an implemented port or adapter. Historical basis:
core port v2 at 93460326 and core binding/claim adapter at
 a89392c52c45612480a67c3394f7f905514bb1cf. Core owns the constructor, application
contract, schema and durable enforcement. Runtime owns provider supervision only.

## Explicit server-side context

Prefer a core-owned supervisor-bound store handle over adding caller-supplied
namespace strings to every runtime method. Its immutable context contains:

- Owner ID: existing method arguments and supplied claims/admissions must match.
- Provider kind and provider namespace: an explicit, stable, opaque identity for
  the provider/profile authority domain. Never derive this from a native session
  ID, credential, home directory or browser profile path. No implicit global
  namespace or fallback to a different namespace is allowed.
- Supervisor key: stable identity of the logical supervisor within that domain.
- Supervisor incarnation: unique identity of this supervisor process lifetime,
  distinct from the stable key and from execution lease generations.

These are server configuration and authority context, not web DTO fields. Native
IDs and profile references remain private, non-serializable server records. A
namespace is not itself an authorization credential. Construction stays private
to trusted bootstrap: validate the configured grant, then atomically register or
acquire the context. Arbitrary requests cannot construct or broaden a handle.
Every RuntimeStore method must validate all supplied IDs against its bound context.

The existing native identity uniqueness reservation by provider kind, namespace
and native session ID should remain intact, including historical identities.
Different namespaces may contain the same native token without aliasing. Sharing
one provider/profile authority requires the same configured namespace; changing
supervisor incarnation must not manufacture a new native identity domain.

## Ownership and recovery

Core should persist supervisor association before admitting work and validate it
alongside owner, binding, lease expiry and dispatch fence in every mutation.
Two different supervisor keys in the same namespace must not recover or fence
one another. Canonical fast/deep bindings remain unique per conversation/role;
a second supervisor cannot obtain a second canonical pair or silently steal it.

Restart takeover of the same supervisor key requires an atomic, exclusive,
store-issued incarnation transition. A random new incarnation string alone does
not authorize takeover. Require an authorized handle grant, exact predecessor
incarnation/version CAS and authoritative supervisor lease expiry. Refuse an
active predecessor with Busy; this slice has no force path. One transaction issues
the new incarnation and fences its predecessor, with exactly one concurrent
winner. Preserve unknown work for reconciliation.

The existing recover_runtime supervisor_instance argument must equal the bound
incarnation. Recovery queries must also constrain owner, provider namespace and
stable supervisor key. The caller's now_ms cannot override authoritative store
expiry decisions. Pagination must retain those constraints. Recovery preserves
unknown in-flight work and requires reconciliation; it never resumes a turn or
infers that interruption succeeded. A different namespace/key requires a separate
authorized handle, never a recovery argument override.

This can preserve the existing RuntimeStore method signatures if core supplies
and enforces the bound handle. Until that enforcement and takeover contract are
implemented, run admission, native binding and recovery remain Unavailable.
The runtime's fresh-dispatch/replay guard remains independently required. No
exported constructor or handle type signature is agreed by this document.

## Required independent evidence

Core-owned regression cases must cover identical native tokens in distinct
namespaces; two supervisor keys sharing a namespace with recovery of one leaving
the other untouched; same-key restart fencing only the predecessor; concurrent
takeover; forged recovery incarnation; cross-owner/context admission and event
replay rejection; and pagination retaining the recovery scope. Atomic admit/ack,
observation deduplication and cancellation fencing remain separate requirements.

No schema, constructor, takeover mechanism or durable acceptance is implemented
by this proposal. No build or tests were run for this document.
