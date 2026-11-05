-- Standing operator policy is distinct from an ad-hoc owner handoff decision.
-- Match records preserve conversation scope for short continuations/children.
CREATE TABLE conversation_provider_policy_matches (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 rule_id TEXT NOT NULL CHECK(length(rule_id) BETWEEN 1 AND 64),
 policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
 source_commit TEXT NOT NULL CHECK(source_commit='unknown' OR length(source_commit)=40),
 source_message_id TEXT NOT NULL REFERENCES messages(id),
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,rule_id,policy_sha256,source_message_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TABLE operator_provider_handoffs (
 handoff_id TEXT PRIMARY KEY REFERENCES conversation_provider_handoffs(id),
 source_message_id TEXT NOT NULL REFERENCES messages(id),
 policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
 source_commit TEXT NOT NULL CHECK(length(source_commit)=40),
 rule_ids_json TEXT NOT NULL
);
CREATE TRIGGER provider_policy_matches_immutable_update BEFORE UPDATE ON conversation_provider_policy_matches BEGIN SELECT RAISE(ABORT,'provider_policy_match_immutable'); END;
CREATE TRIGGER provider_policy_matches_immutable_delete BEFORE DELETE ON conversation_provider_policy_matches BEGIN SELECT RAISE(ABORT,'provider_policy_match_immutable'); END;
CREATE TRIGGER operator_provider_handoffs_immutable_update BEFORE UPDATE ON operator_provider_handoffs BEGIN SELECT RAISE(ABORT,'operator_provider_handoff_immutable'); END;
CREATE TRIGGER operator_provider_handoffs_immutable_delete BEFORE DELETE ON operator_provider_handoffs BEGIN SELECT RAISE(ABORT,'operator_provider_handoff_immutable'); END;
