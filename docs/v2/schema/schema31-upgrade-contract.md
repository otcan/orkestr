# Schema 31 copy-first upgrade contract

The bounded supported source edges are known-checksum, structurally exact,
contiguous migration prefixes 1–14 and 1–17 to Core
`41309628e21e6580df458346607220f6413ccc63`, migration 31. This is a schema
compatibility contract, not package, native-process or live-upgrade acceptance.
Installation owns checks against the pinned old executable and populated stopped
copies. Never run the old executable against a migrated database; rollback
restores the untouched stopped backup and its matching old executable.

`schema31-fingerprints.json` pins every SQL file through 31. `sqlx_sha384` is the
raw SQL-byte SHA-384 used by SQLx migration checksum verification; SHA-256 is
included for artifact comparison. Neither replaces the complete schema check.
Store preflight requires WAL mode, a successful contiguous exact migration
history, and equality of the complete SQLite schema (tables, indexes, triggers)
to the schema reconstructed from that exact prefix. Changed checksums, unknown
schema objects, unsuccessful or future versions refuse. The writable upgrade
must pass on the isolated copy, retain existing row/FK assertions and produce
exactly the target schema; constraint-invalid data is not repaired implicitly.

Migration 31 adds private nullable issuing-machine token-digest lineage to
Worker tasks. Existing queued/claimed rows become held and their claim hashes
are cleared because their original issuing credential cannot be established.
Their payloads and delegated/historical mappings remain. New pending tasks
require issuer lineage. Exact parent control/terminal/context/binding/readiness
and issuing-auth invalidation atomically hold pending tasks; unrelated browser
logout and ordinary progress/lease extension do not. Clock passage alone emits
no write: the bounded sealed-handle negative reconciliation handles observed
expiry, without issuing or resuming authority.

Core's registered-source checks passed 26 task Store tests (including the real
version-30 upgrade) and nine preflight tests (including populated schema-14
preservation), strict feature-enabled Store/contracts all-target Clippy, fmt and
diff checks. These do not claim a populated schema-17 package probe, transport
cleanup, native continuation, or a production rollout. Schemas 32/33 are not in
this checkpoint and must not be synthesized by packaging.
