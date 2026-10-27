-- Concurrent window Fast presentations. Slot 0 stays the canonical Fast
-- lineage (ensure_role_bindings, window reattachment, Deep companion); slots
-- 1-7 are single-presentation auxiliary Fast sessions of one live window.
-- Uniqueness stays in the schema: one live record per conversation, role and
-- slot, so at most 8 live Fast records and still exactly one live Deep record.
-- Existing rows become slot 0; no binding, run, input or native ID changes.
ALTER TABLE session_bindings ADD COLUMN fast_slot INTEGER NOT NULL DEFAULT 0
 CHECK(fast_slot BETWEEN 0 AND 7 AND (fast_slot = 0 OR role = 'fast'));
DROP INDEX canonical_role;
CREATE UNIQUE INDEX canonical_role ON session_bindings(owner_id, conversation_id, role, fast_slot)
 WHERE role IN ('fast','deep') AND state <> 'retired';
