# Reviewed authority edges after the grouped thread checkpoint

Root reviewed and executed the corrected aggregate projections in a bounded
read-only process. Migration has read the private receipt and retained its
aggregate coverage privately. The grouped thread observations now have actual
execution evidence. They describe explicit persisted metadata, not active work,
effective binding capabilities or daily-use parity. No actual counts, runtime
identifiers or deployment paths are published here. No rerun was performed.

## Next workflow authorities: source review

| Authority / existing route | Reviewed call chain | Disposition |
|---|---|---|
| Gmail/calendar account capabilities: `GET /api/connectors/gmail/accounts` | `connectors.controller.ts::gmailAccounts` -> `google-workspace-connections.js::listGoogleWorkspaceConnections/repository/migrateLegacyGoogleWorkspaceConnection` | NOT a safe census call: repository can read legacy secret/token state, write encrypted credentials and registry, then remove legacy token file. GET is not evidence of inert behavior. No call made. |
| Timer doctor: `GET /api/timers/doctor` | `timers.controller.ts::doctor` -> `timers.js::doctorTimersForPrincipal/doctorTimers` | Directory initialization, timer registry loading, full thread listing and promptFile existence probes; response includes private issue details. Not used for this census. Need authority-owned aggregate projection bypassing those operations. |
| Timer list: `GET /api/timers` | `timers.controller.ts::list` -> registry listing and `agent-job-timer-entries.js` | Registry/prompt-bearing output and job-store initializer remain excluded. |
| Personal-agent availability: `GET /api/personal-agent/capability` | `personal-agent.controller.ts::capability` -> `personal-agent-capability.js::personalAgentCapability/personalAgentStorageReady` | Source shows authenticated owner/admin guard, feature check, readOnly SQLite required-table metadata check. Returns fixed availability booleans/reasons. Appropriate candidate for authorized status observation; no call made here. Availability is not memory/task use and does not cover external authorities. |
| Mailbox status | `mailboxes.controller.ts::delivery-status/route-status` | Mailbox-specific identity/route authorization and implementations need review; no calls or route reads made. |
| Personal memory | `personal-agent-memory-migration.js` | Declares one job-store-backed table with content/provenance/consent and category/scope constraints. This is not proof that it is the main used memory authority; no table/body query made. |
| External mail/calendar/OXRM/skill memory | Separate connectors/skills/private overlay authorities | No reviewed all-authority count/status contract identified. Do not infer absence from the job store or thread flags. No credential/profile/private-registry inspection performed. |

Precise next inventory dependency: connector/timer owners should identify a
side-effect-free, authenticated aggregate status projection for enabled fixed
capability classes and timer enabled/cadence/target-class buckets. It must avoid
legacy migration, token refresh/relink, promptFile probes, raw targets and
profile reads. Do not route these queries through the existing unsafe GET chains.
Main messaging holds and the personal skill-only router/autostart exclusion are
preserved. No connector or route actions are authorized by this inventory.

## Actual V2 read port and bounded export increment

The existing published symbols are:

- `v2/crates/application/src/lib.rs::IntakeStore::snapshot(owner, conversation, after, limit)`.
- `v2/crates/contracts/src/lib.rs::ConversationSnapshot/Message/Scope`.
- `v2/crates/store-sqlite/src/intake.rs::snapshot`: reads a current scope/high-water
  mark, then ordered message rows bounded by that mark; limit clamps to 1..100.

`v2/migration/conversation_export.py::collect_pages` now validates and collects
already-authorized pages of that actual contract. It performs no I/O and accepts
no provider or store callback. Starting at cursor zero is a caller prerequisite.
It rejects scope/conversation/high-water changes, bad cursors, duplicate message
IDs, nonascending/out-of-cut sequences, incomplete/trailing pages, extra fields,
noncanonical UUIDs and type/bound violations. Bounds are 100 messages per page,
1000 pages, 16 MiB canonical input bytes and nonnegative signed-64-bit sequences.
It returns an assembled published snapshot plus deterministic SHA256, without
modifying input. Unknown actor strings/text are preserved exactly, not guessed
into migration roles or scanned for secrets.

This collector does not authorize live history reads. Only public synthetic
contract fixtures were used. It is not a cross-store consistency proof, complete
legacy export, privacy scanner, product backup or dormant importer. Message text
would be private if an authorized future caller supplied it; do not log/commit
actual exports. Pages can omit content dishonestly: structural checks cannot
independently prove source completeness. It does not require contiguous message
sequences beyond the published ascending cursor contract.

### Exact dependency request to Core/coordinator

The current snapshot method takes no frozen export cut/receipt argument, so a
later page can observe a different watermark. The collector safely refuses this;
it must not silently mix cuts. Core should identify a transaction/cut-bound
snapshot reader that fixes the owner, conversation, source version, high-water
mark and receipt across every page. This can adapt existing published types;
Migration does not invent or edit a Core schema/store/API here.

No dormant import/apply, import provenance, conditional deactivation/rollback or
V2-only delta export port exists in this inspected trait. Please delegate the
exact owner-scoped dormant batch interface and revision/provenance contracts.
`IntakeStore::admit` is live intake and MUST NOT be used for historical import.
Rollback needs batch-owned unchanged revisions and preservation of all legacy,
V2-only delta and sticky quarantine evidence, as described in
`dormant-rollback-edge.md`. No real import/rollback can be implemented honestly
by treating conversation snapshot or count projections as those ports.

Validation: 80/80 synthetic tests pass, including seven collector tests covering
published fixture roundtrip, deterministic multipage collection, changing cuts,
empty conversations, cursor/order/identity failures, trailing/incomplete pages,
strict fields and byte/page bounds. Live export/import/rollback, status calls,
push and CI remain unexecuted.
