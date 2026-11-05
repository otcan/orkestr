-- Native correlation is evidence, never authority. Only Core's live canonical
-- Deep dispatch issues one operation; unknown delivery is never replayed.
CREATE TABLE deep_desk_operations (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    incarnation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    binding_generation INTEGER NOT NULL,
    setup_generation INTEGER NOT NULL,
    lease_generation INTEGER NOT NULL,
    dispatch_fence INTEGER NOT NULL,
    native_session_id TEXT NOT NULL,
    native_turn_id TEXT NOT NULL,
    native_call_id TEXT NOT NULL,
    correlation_sha256 TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('delivery_unknown','helper_completed','failed','cancelled')),
    created_at_ms INTEGER NOT NULL,
    UNIQUE(owner_id,run_id,native_call_id)
);
CREATE TABLE deep_desk_results (
    operation_id TEXT PRIMARY KEY NOT NULL REFERENCES deep_desk_operations(id),
    payload_sha256 TEXT NOT NULL,
    written_bytes INTEGER NOT NULL DEFAULT 0 CHECK(written_bytes>=0),
    state TEXT NOT NULL CHECK(state IN ('delivery_unknown','delivered'))
);
