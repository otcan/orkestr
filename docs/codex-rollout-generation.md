# Codex rollout generation fencing

Orkestr treats `runtime.codexThreadId`, the executor Codex ID, the root Codex ID,
and executor metadata as one generation identity. Conflicting non-empty values
are ambiguous and fail closed; a runtime-only ID is a valid current generation.

Rollout ingestion can be staged with `ORKESTR_CODEX_GENERATION_ROLLOUT_MODE`:

- unset or `off`: preserve legacy rollout selection while using the canonical
  live-notification lookup and durable final projector;
- `shadow`: validate the bounded `session_meta.payload.id` head record and emit
  proposed reject/rebind diagnostics without changing rollout selection;
- `enforce`: consume assistant content only from a rollout whose session ID
  matches the current generation. Paths and cursors are generation-scoped.

Fresh generation starts and safe resets always invalidate old rollout paths,
offsets, synchronization state, and metadata caches. Runtime doctor reports
ambiguous identities, missing or malformed session metadata, generation
mismatches, completed turns without a final projection, and WhatsApp finals
without durable delivery state. `repair=true` changes only unambiguous verified
state; repeating a successful repair is a no-op.

Diagnostics include thread, generation, turn/item, projection source, outcome,
and a path fingerprint. They do not include message content or raw rollout paths.
