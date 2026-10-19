# Stopped metadata descendant gate

Stopped Deep/Fast continuation now reuses the ordinary terminal retirement
`descendants_clear` ledger check in the central resumed-binding validator.
Issuance, every metadata callback fence, resumed confirmation, and Claude
process-initialization confirmation therefore refuse unresolved descendants.
No migration, historical receipt, or accepted continuation policy changes.

The check is negative authority only. It does not establish native cleanup:
the server must still retain the original Runtime reap witnesses for every
launched parent and Worker before opening a replacement process.

Validation: four focused stopped-metadata tests pass, including a confirmed
Worker setup without terminal evidence and residual pending task rows at
issuance and after grant issuance. The residual-row test deliberately injects
invalid lifecycle residue to check defense in depth; it is not a public
authority construction path. The terminal suite passed 31 tests. Strict Store
all-target feature Clippy, workspace formatting and diff checks pass.

Additional current-authority regression checks a previously issued stopped grant
following public machine-session revocation and, separately, an adversarial
persisted supervisor-generation mismatch. Both refuse issuance, run zero metadata
callbacks and refuse confirmation without changing execution snapshots or the
issued reservation. The generation fixture proves obsolete-context refusal; it
is not evidence of native cleanup or a real predecessor takeover. The focused
stopped-metadata suite now contains five passing tests.
