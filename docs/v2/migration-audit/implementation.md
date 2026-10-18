# Inert migration planning implementation

The original field audit remains pinned to
`76f9c6cd91e094329ae5c29c7e95f301366ed02a`. New migration tooling lives only in
`v2/migration/`; it does not change Core, schemas, root manifests or runtime wiring.
This is the first implementation increment, not importer/apply acceptance.

## What executes now

`migrate.py validate SNAPSHOT` validates an explicit copied bundle. `plan SNAPSHOT
LEDGER` locks and atomically replaces a private **inert plan artifact**, preserving
previous identity digests and recording repeatable conflicts. The ledger is not a
parallel application store and no code consumes it as execution authority. UUIDv5
identifiers are deterministic proposed mapping IDs, not coordinator-approved Core
IDs. Source composite identity includes source instance, kind and key components.

A valid record becomes HISTORY_ONLY, PAUSED or QUARANTINED. Runs, timers, routes,
approvals, automations and jobs always become PAUSED unless quarantined. Source
state remains exact evidence, including historical terminal states. PAUSED is a
plan disposition, **not a new runtime enum**. Effects are always quarantined for
reconciliation; unknown states never become success. Missing ownership/scope,
missing/cross-owner references, cycles, message order collisions, unsupported
kinds/relations and missing artifact references produce explicit reasons. Changed
content under the same identity quarantines the existing mapping and records both
digests, without overwriting its original fingerprint. No raw source text or effect
arguments are written to the ledger. Raw history remains in the immutable bundle.

`bundle-export` and `bundle-restore` copy only a validated manifest and its listed,
hash-checked files to a fresh directory. Unlisted files are excluded. These commands
copy **inert interchange bundles**; neither can open/export/restore SQLite or a
running application. `ledger-export` and `ledger-restore` recover only the plan
ledger, including legacy and V2-only delta decisions, with a self-digest and fresh
target requirement. Self-digests detect corruption, not malicious replacement.
Source data is never deleted or updated. Permissions are 0700 for created bundle
directories and 0600 for files. Caller-created output parents must be private.

## Proposed interchange adapter edge (not a canonical Core contract)

The concrete public example is
`v2/fixtures/migration-audit/snapshot-v1/snapshot.json`.
All document/record/manifest object fields are strict, with these required keys:

| Object | Fields |
|---|---|
| Snapshot | `version: 1`, `source_instance`, `source_version`, `schema_versions` (store name to source version string), `snapshot_id`, `origin` (`legacy` or `v2_delta`), `consistency`, `records`, `artifacts`, `counts`, `digest` |
| Consistency | `method` (`synthetic` or `coordinated_snapshot`), `watermark`, `segments` (authority name to identical watermark), `export_receipt` |
| Record | `kind`, `key` (nonempty array of source primary-key strings), `owner`, `scope`, `source_state` (nullable source string), `references`, `payload` |
| Reference | `relation`, `kind`, `key` |
| Artifact | `path` (canonical relative POSIX path), `sha256`, `bytes` |

Snapshot `digest` is SHA-256 over UTF-8 Python JSON serialization of the object
without `digest`, `sort_keys=True`, `separators=(',', ':')`, `ensure_ascii=True`,
`allow_nan=False`. Artifact hashes cover bytes. Duplicate JSON keys, extra manifest
fields, count/digest mismatch, inconsistent watermark declarations, unsupported
format versions, path traversal, symlinks and missing/changed artifacts fail
validation. Maximum JSON/artifact size is 16 MiB per file in this bounded slice.
Message keys must be `[thread_id, message_id]`; resource keys should contain
`[resource_type, resource_id]`. Preserve source positions/cursors/timestamps in
payload, not as invented target sequence/time. Payload must already be redacted.
A recursive field-name denylist catches common forbidden fields; it is **not a
privacy scanner** and cannot detect a secret embedded in text or an arbitrary key.

`export_receipt` and matching segment watermarks are producer assertions, not
proof of SQLite/WAL or cross-store consistency. Only the approved producer adapter
can establish that guarantee. No existing API is claimed to emit this format.
No public API endpoint, SQL schema or importer approval is created by this format.

## Installation / Core handoff

Keep installation's SQLite recovery manifest separate. SQLite
`Connection.backup` can produce a consistent copy of a **single** database; it
cannot establish consistency with registry JSON, other DBs or external artifacts.
A full database backup retains auth/session **rows**, even if provider/auth files
are omitted. Such recovery archives need private storage and disclosure; they are
not credential-free migration exports. This lane neither reads nor rewrites them.

Core must provide:

1. A side-effect-free, owner-authorized count-only workflow inventory API. It must
   enumerate configured kinds and omitted/unsupported categories without history,
   credential/profile reads, schema initialization, native sync or dispatch. See
   [source inventory](source-inventory.md) for why current GETs are insufficient.
2. A redacted, coherent snapshot producer with versioned export receipt, all
   independently persisted authorities, a consistency boundary/watermark and
   tombstone/retention handling. It must explicitly resolve owner/scope and retain
   composite source IDs, original order, lineage, acceptance/result evidence and
   exclusions. Adapter output can be checked by this proposed interchange once
   coordinator/Core approve or replace its fields.
3. An atomic historical apply port into a fresh inactive target. It must persist
   provenance, ID mappings and quarantine without runtime admissions, auth/session
   rows, active approvals, grants, routes, retries, inbox/outbox or timer catch-up.
   Per-record PAUSED dispositions must have a schema-owned dormant representation.
4. A V2-only delta export/reconciliation port bound to a cutover watermark, with
   tombstones and uncertain effect receipts. The current ledger can distinguish
   `origin=v2_delta`, preserve legacy decisions and recover both; it cannot extract
   real V2 state or supply a reverse migration into 1.x.

Until these ports land, actual consistent production export/import, canonical
migration restore and a live inventory of **all used** workflow kinds are blocked.
This is a concrete Core dependency, not authorization to inspect private DBs or
change schemas. No cutover, production interruption, route rebinding, credential
copying or unpausing is performed. Existing channel holds and personal skill-only
routing remain outside these tools and are preserved by absence of live actions.

## Explicit runtime mapping refresh

Read-only comparison at integration candidate `829a53dd`:
`v2/crates/contracts/src/runtime.rs` has `RUNTIME_PORT_VERSION=5` and RunState
`starting`, `running`, `cancel_requested`, `cancelled`, `blocked`, `failed`,
`awaiting_acceptance`, `succeeded`. Unlike the original pinned audit it has no
`queued` variant and adds `awaiting_acceptance`. No conversion is inferred:
legacy `pending/retrying/awaiting_approval/skipped` remain exact source evidence.
Even same-spelled states grant no runtime authority. Original audit fixtures keep
their baseline-specific enum expectations; the new planner recognizes legacy
states independently and emits only inert dispositions. Future enum changes need
another explicit reviewed mapping refresh.

## Executed evidence and limits

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 v2/migration/migrate.py validate v2/fixtures/migration-audit/snapshot-v1
python3 v2/fixtures/migration-audit/validate.py
git diff --check
```

The implementation suite covers snapshot integrity, deterministic mappings,
repeat/conflict behavior, identity/order/lineage quarantine, paused operational
kinds, concurrent CLI writers, reopen, permissions, source preservation,
artifact/path rejection, corruption rejection, fresh-target bundle recovery and
V2-only delta ledger reconciliation. Tests use temporary synthetic paths only.
Live API inventory, production snapshots, Core apply/replay, real V2 delta export,
Cargo/build, provider/connector, CI and cutover checks are **unexecuted** here.
