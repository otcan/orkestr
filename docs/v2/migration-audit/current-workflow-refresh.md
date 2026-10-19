# Current workflow census and release assignments

This census replaces storage-order message sampling with indexed recent ranges.
Private receipts and the private decision table are deployment evidence and do
not belong in this repository. Every workflow below remains required, including
those whose current use cannot be resolved. Configuration, recorded activity,
process presence, valid authority and successful execution are different facts.

## Source and collection contract

The deployed source authorities are `packages/storage/src/paths.js::dataPaths`,
`thread-message-schema.js::ensureThreadMessageSchema`, `packages/core/src/threads.js`,
`timers.js::markDueTimersPass`, `runtime-leases.js`,
`packages/browsers/src/browsers.js::listBrowserSessions`,
`desktop-leases.js::publicDesktopLease`, and
`packages/connectors/src/google-workspace-connections.js::readRegistry`.
The connector worker separately uses
`whatsapp-scoped-native-worker.js::scopedNativeWorker`,
`whatsapp-scoped-route-membership.js::scopedRouteMembership` and
`whatsapp-delivery-route-fence.js`.

`v2/migration/current_activity.py::recent_messages` uses the existing covering
index's metadata prefixes followed by timestamp range searches. It counts the
last thirty days and last day in one pinned read-only transaction. All prefixes
and JSON remain inside SQLite; only fixed counts leave it. The source index,
real table and permitted SQL operations are checked; missing index, symlinks,
non-UTC observation and a query exceeding its progress deadline refuse.
Canonical source UTC timestamps are assumed. Missing or noncanonical timestamps
remain uncovered; future timestamps are excluded. Attachment presence reads
only the fixed JSON array predicate, never attachment contents or paths.

Local status requests use the existing trusted host-operator boundary, without
extracting credentials. Personal-agent capability rejects this principal:
that is an unavailable selector for this principal, not an absent capability.
Gmail accounts GET is excluded because its legacy migration can mutate state.
The known nonsecret connection registry supplies capability/health metadata
without dereferencing token references. No profiles, message bodies, contact
mirrors, credentials or external services are read.

Browser manager `status`/`state` must be classified explicitly; missing boolean
`running` does not mean stopped. A desktop lease's `active` means unreleased;
expired or stale records are not valid execution authority. Runtime lease
history and thread session references likewise do not prove a current session.
Timer `lastRunAt` records an enqueue attempt, not successful completion.
Independent transactions/files/API responses do not constitute one coherent
cross-authority cut. Cached worker policy may differ from a file read.

## Required parity and smallest remaining acceptance

Published implementations below are scoped paths, not a statement that one
release artifact includes and qualifies every path. The release owner must pin
and test the composed candidate.

| Workflow | Existing V2 path | Concrete remaining implementation / assignment | Smallest acceptance |
|---|---|---|---|
| WA routing, mute and held inputs | `apps/server/src/held_inputs.rs`, Store history quarantine and ordinary-input holds | Connector/Runtime: reconcile effective worker route fence with relay mute and held-input authority; retain personal skill-only exclusion. No migration may activate a route. | Synthetic muted route plus held replay produces zero intake/send; explicit authorized unmute admits only eligible new input, never held history. |
| Timers | PR111 durable controller, `history_import/timers/authority`, scheduler supervisor and ordinary-input bridge | Migration/Verification/Installation: compose canonical schema and mounted owner controls into one release; retain ambiguous timezone/cadence as dormant. Multi-day elapsed operation and relevant crash windows remain separately gated. | Fresh owner text, logout, process restart, natural due yields one input; disable/revoke before due yields none; historical enable retry cannot rearm. |
| Provider sessions and local execution | `apps/server/src/execution_registry.rs`, `claude_execution`, `crates/orkestr-runtime/src/claude_rpc.rs`, Store production runtime | Runtime/Isolation: inventory each live provider class and qualify fresh native session attachment/continuation, cancellation and revocation. References or an active service are insufficient. Never migrate native credentials. | Synthetic scoped session survives server restart under fresh current auth; Stop/revoke prevents the next callback; unknown provider remains held. |
| Local projects/worktrees | `apps/server/src/worker_execution/directory.rs`, `configuration.rs`, project fixtures | Runtime/Installation: reconcile existing workspace/worktree authority with V2 directory allowlists and ownership; preserve unresolvable references without executing them. | Disposable repository with parent/worker worktrees reopens under allowed scope; cross-owner/path escape refuses; artifacts survive. |
| Attachments and artifacts | `v2/acceptance/browser/worker-artifacts.mjs`, schema36 reconciliation | Core/UI/Installation: establish end-to-end attachment manifest, byte integrity, owner authorization and download retention. UI worker-artifact coverage does not establish legacy attachment import. | Synthetic attachment export/restore compares digest/length and owner-scoped download; missing bytes and unauthorized access refuse. |
| Browser manager and leases | Runtime capability boundary; `apps/server/src/browser.rs` is web authentication, not desktop-manager parity | Browser/Isolation: provide manager integration with current lease heartbeat/expiry/revocation and scoped browser operation. Do not copy profiles or resurrect stale leases. | Synthetic manager grants one scoped lease; expired/revoked lease cannot act after restart; fresh acquisition remains explicit. |
| Mail/calendar and optional connectors | Ordinary execution/capability infrastructure; nonsecret legacy connection metadata | Connector specialist: implement fresh credential-backed capability status and scoped read operations; keep send separate. Owner-only status needs an appropriate authenticated boundary. | Fake connector exposes read-ready vs unavailable vs forbidden; revoked read refuses; census/status performs no refresh, migration or send. |
| Memory | Inert history/recovery ledger and schema36 reconciliation | Memory specialist/Core: identify configured external authority and implement scoped reads/writes only where approved; absent local tables do not establish non-use. | Fake authority preserves namespace and provenance; unauthorized lookup refuses; no background ingestion. |
| OXRM | Generic capability/auth boundaries and inert provenance | OXRM specialist: retain canonical external authority and implement scoped status/reference access, never a contact mirror or token duplication. | Fake canonical service verifies scope and revocation; migration exports references only, no contacts and no outbound actions. |

Counts are never a retirement decision. Unresolved authority and acceptance
remain blocking until the named owner provides evidence. Frozen schema36
retention is structural preservation, not active recovery, credential restoration
or lossless reverse import into the legacy application.
