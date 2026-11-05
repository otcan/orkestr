-- Fresh continuation admission evidence only. Never infer/backfill old fences
-- from message text, the current provider, or a replayed POST's supplied fields.
CREATE TABLE source_admission_fences (
 message_id TEXT PRIMARY KEY REFERENCES messages(id),
 expected_provider_generation INTEGER NOT NULL CHECK(expected_provider_generation>=0),
 source_run_id TEXT NOT NULL REFERENCES production_runs(id),
 source_native_session_id TEXT NOT NULL CHECK(length(source_native_session_id) BETWEEN 1 AND 4096),
 source_provider TEXT NOT NULL CHECK(source_provider IN ('codex','claude')),
 source_binding_generation INTEGER NOT NULL CHECK(source_binding_generation>0)
);
CREATE TRIGGER source_admission_fences_fixed BEFORE UPDATE ON source_admission_fences
 BEGIN SELECT RAISE(ABORT,'source admission fence is immutable'); END;
CREATE TRIGGER source_admission_fences_no_delete BEFORE DELETE ON source_admission_fences
 BEGIN SELECT RAISE(ABORT,'source admission fence is immutable'); END;
