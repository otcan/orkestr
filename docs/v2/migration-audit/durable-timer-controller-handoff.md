# Durable timer controller handoff

Registered Store dependency:
`63323d62a698747900a45db9962b5fb8354117f3` (real contiguous 1–33).
Migration independently compared authority subtree, all six unchanged tests,
input helper and authoritative 0033 SQL against owned
`87904cb45d28e4d4e087f7226d18a7c516592864`: byte-identical.
Core reports timer20/20, preflight9/9 and strict feature lint/format PASS.
These are Core executions, not a Migration rerun. Historical Migration18/20
fixture-only results remain unchanged in the earlier build evidence.

Deep owns mounted server checkpoint `57ab9b1c8b5e09e3cfcbe403ea10015dfda5b7db`,
common router, AppState, supervisor bootstrap and joined shutdown. Migration
must not replace those shared files or start another ordinary input writer.
The mounted one-hour process-local implementation remains bounded until this
successor is composed and independently qualified.

Existing registered Store calls:

- Owner HTTP maps authenticated fresh text to `enable_durable_timer` with the
  existing enable request and instruction. Store uses its transaction clock.
  No stored browser credential, TTL refresh, legacy prompt or imported activation.
- Trusted bound supervisor calls `authorize_timer_scheduler(namespace)` after
  current machine bootstrap. Returned issuer is local, non-Clone and not
  deserializable. Neither owner HTTP nor a persisted grant UUID can mint one.
- Controller calls `admit_authorized_timer(&issuer, namespace)`. No caller time,
  text, due, claim or browser token exists. Current context/machine authorization,
  grant generation, Stop watermark and due are checked inside the write transaction.
- Owner revoke maps to canonical disable; Stop/rollback also fence old generation.
  Retry may return historical authority provenance but cannot re-enable it.

Remaining minimal Store dependency proposed to Core (not published API):

```rust
Store::timer_scheduler_candidates(after: Option<Uuid>, limit: u16)
    -> history_import::Result<Vec<Uuid>>
```

This must validate the current authenticated bound supervisor/context in its
read transaction before owner-scoped enumeration. Return at most32 namespace
UUIDs, joining enabled timer current generation to durable authority, ordered
by namespace with keyset cursor. No instructions or credential data returned.
Discovery is metadata, never scheduler authority; authorize a namespace issuer
and revalidate every subsequent admission independently. Cursor wraps after end
so more than32 timers receive fair bounded passes. Do not enumerate owner IDs or
hold an idle snapshot across passes. Core owns context-validation integration.

Migration can own a new controller leaf once that exact seam is settled: one
bounded pass (<=32 candidates, five-second deadline), skipped missed polling
ticks, no credential/text cache or hourly expiry. Drop local issuers on shutdown
or context replacement; restart bootstraps fresh machine context and resumes
only persisted explicitly granted generations. Auth refusal stops that context;
not-due/conflict does not revoke persisted grant. Lost admission response must
not repeat an occurrence: the existing durable claim/intake transaction owns
cadence and dedupe. No external dispatch is performed directly by the controller.

Acceptance still required: exact registered-source independent Store rerun;
actual bound-supervisor issuer→leaf admission including revoked/stale/wrong
namespace refusal; ordinary binary clean restart and process-crash recovery;
long daily/weekly schedule across restart with no hourly owner rearm; creator
browser logout independent from scheduler machine revoke; Stop/disable races
before and after admission with zero unauthorized callbacks. Deep owns shared
composition and Verification independent process oracle. No scheduler, native
provider, durable HTTP or full-release acceptance is inferred from Store tests.
UI must retain current bounded wording until the mounted successor has exact
reviewed DTO/read-state semantics and corresponding acceptance evidence.
