-- Read-only parallel Deep slots (docs/v2/parallel-deep.md). Slot 0 stays the
-- canonical Deep lineage (the single writer: ensure_role_bindings, window
-- reattachment, successor anchor). Slots 1-3 are single-turn read-only Deep
-- sessions of one live window, started only while the owner's switch is on.
-- Uniqueness stays in the schema: one live record per conversation, role,
-- Fast slot and Deep slot, so still exactly one live canonical Deep record.
-- production_deep_claim is unchanged: an inbox input is still consumed by at
-- most one Deep run, canonical or parallel.
-- Existing rows become slot 0; no binding, run, input or native ID changes.
ALTER TABLE session_bindings ADD COLUMN deep_slot INTEGER NOT NULL DEFAULT 0
 CHECK(deep_slot BETWEEN 0 AND 3 AND (deep_slot = 0 OR role = 'deep'));
DROP INDEX canonical_role;
CREATE UNIQUE INDEX canonical_role ON session_bindings(owner_id, conversation_id, role, fast_slot, deep_slot)
 WHERE role IN ('fast','deep') AND state <> 'retired';
-- Which window incarnation set up each parallel slot session. A slot never
-- outlives its window: settled slots retire with the context.
CREATE TABLE production_parallel_deep_slots (
 session_id TEXT PRIMARY KEY REFERENCES session_bindings(id),
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL
);
-- Owner opt-in, read live by the window scheduler. Default off: one Deep
-- lineage per window, exactly as before this schema.
ALTER TABLE conversation_settings ADD COLUMN parallel_deep INTEGER NOT NULL DEFAULT 0
 CHECK(parallel_deep IN (0,1));
