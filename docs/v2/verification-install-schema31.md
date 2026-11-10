# Schema-31 installation acceptance source review

Exact Installation source: `61308c6a93e3efe8ab2dc5162be23a268dbcacbb`. Exact canonical migration source: Core `41309628e21e6580df458346607220f6413ccc63`. No blocking finding in the bounded schema-31 extension review.

Preparation verifies original packages, source and binary pins, contiguous migration inventory, unchanged predecessor migration hashes, and exact Core migration bytes before execution. Schema 31 additionally requires the pinned full inventory digest and SQLx checksums. Only the explicit 14/17-to-31 edges are admitted; inspecting a later inventory does not admit its execution. No supplied binary was executed during this review.

The existing stopped-copy preflight precedes working-home migration. It checks the original database/sidecar inventory remains unchanged, then audits migration and successor reopen. The added read-only authority audit preserves task identity and delegation linkage, requires old pending tasks to become held with no claim, refuses added run/delegation identities and selected run-authority reactivation. This is a scoped row audit, not proof of all ledger columns or provider authority.

Independent execution in an exact disposable export passed **22 supplied tests**: cross-revision policy 7, candidate upgrade preparation 10, authority audit 3, and actual SQLite schema contracts 2. No skips or failures. The SQL tests used all 31 exact Core migration files and verified their pinned inventory, populated 14/17 upgrade history/FKs, version-30 pending task holds, retained payloads/delegation history and reopen integrity.

This independently executes author tests; it is not a schema-31 binary/package upgrade, actual launcher acceptance, browser/provider execution or production qualification. No rebuild, host policy change or service launch occurred.
