# Canonical public references

Orkestr can assign immutable, opaque public references to the local runtime,
registered broker instances, and threads. Instance references use `ins_` and thread references use
`thr_`; both contain 128 bits of random entropy encoded as canonical base64url.
Internal instance IDs, thread IDs, names, and bindings remain unchanged.

This foundation is disabled by default. It does not enable canonical HTTP
routes by itself. To preview the backfill:

```bash
npm run canonical-refs:migrate -- --dry-run
```

The dry run reports counts only. It deliberately does not generate references
that could be mistaken for committed assignments. To apply:

```bash
ORKESTR_CANONICAL_INSTANCE_URLS=1 npm run canonical-refs:migrate -- --apply
```

Apply validates every existing reference and collision before writing. It is
idempotent: subsequent applies retain the same references. If the instance
identity write fails, the thread write is restored to its pre-migration state.
The supported JSON registry writer uses atomic temporary-file replacement, and
the SQLite writer commits each registry replacement in one transaction. The
migration restores earlier stores when a later atomic write reports failure;
operators should not substitute writers that persist successfully and then
throw without providing their own transaction or recovery boundary.

Roll back routing by disabling `ORKESTR_CANONICAL_INSTANCE_URLS`. Do not delete
assigned references: they are additive aliases and remain available for a later
roll-forward. Legacy IDs and names continue to be persisted for compatibility.
