-- Read-only mailbox actions and opaque owner selections. No model input or
-- chat-delivery digest is created by these records.
CREATE TABLE tracker_source_selections (
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision>0),
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
 selection_json TEXT CHECK(selection_json IS NULL OR (json_valid(selection_json) AND length(selection_json)<=16000)),
 acknowledged INTEGER NOT NULL CHECK(acknowledged IN(0,1)), created_ms INTEGER NOT NULL,
 CHECK((selection_json IS NULL AND acknowledged=0) OR (selection_json IS NOT NULL AND acknowledged=1)),
 PRIMARY KEY(owner_id,conversation_id,source_revision),
 UNIQUE(owner_id,conversation_id,request_key),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES trackers(owner_id,conversation_id)
);
CREATE TRIGGER tracker_source_no_update BEFORE UPDATE ON tracker_source_selections
BEGIN SELECT RAISE(ABORT,'immutable_tracker_source_decision'); END;
CREATE TRIGGER tracker_source_no_delete BEFORE DELETE ON tracker_source_selections
BEGIN SELECT RAISE(ABORT,'immutable_tracker_source_decision'); END;

CREATE UNIQUE INDEX tracker_timer_guard_scope ON dormant_timer_input_guards(owner_id,namespace,generation,conversation_id);
CREATE TABLE tracker_scan_authorities (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 conversation_id TEXT NOT NULL, authority_id TEXT NOT NULL UNIQUE,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>0),
 source_revision INTEGER NOT NULL CHECK(source_revision>0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
 classifier_id TEXT NOT NULL CHECK(length(classifier_id) BETWEEN 1 AND 80),
 recipe_id TEXT NOT NULL CHECK(length(recipe_id) BETWEEN 1 AND 80),
 classifier_digest TEXT NOT NULL CHECK(length(classifier_digest)=64),
 stop_sequence INTEGER NOT NULL CHECK(stop_sequence>=0), created_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,namespace,generation),
 UNIQUE(owner_id,namespace,request_key),
 UNIQUE(authority_id,owner_id,namespace,generation,conversation_id),
 FOREIGN KEY(owner_id,namespace,generation,conversation_id) REFERENCES dormant_timer_input_guards(owner_id,namespace,generation,conversation_id),
 FOREIGN KEY(owner_id,conversation_id,source_revision) REFERENCES tracker_source_selections(owner_id,conversation_id,source_revision)
);
CREATE TRIGGER tracker_scan_authority_no_update BEFORE UPDATE ON tracker_scan_authorities
BEGIN SELECT RAISE(ABORT,'immutable_tracker_scan_authority'); END;
CREATE TRIGGER tracker_scan_authority_no_delete BEFORE DELETE ON tracker_scan_authorities
BEGIN SELECT RAISE(ABORT,'immutable_tracker_scan_authority'); END;
CREATE TRIGGER tracker_scan_refuses_instruction BEFORE INSERT ON tracker_scan_authorities
WHEN EXISTS(SELECT 1 FROM durable_timer_authorities a WHERE a.owner_id=NEW.owner_id AND a.namespace=NEW.namespace AND a.generation=NEW.generation)
 OR EXISTS(SELECT 1 FROM dormant_timer_inputs i WHERE i.owner_id=NEW.owner_id AND i.namespace=NEW.namespace AND i.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'timer_work_kind_conflict'); END;
CREATE TRIGGER instruction_refuses_tracker_scan BEFORE INSERT ON durable_timer_authorities
WHEN EXISTS(SELECT 1 FROM tracker_scan_authorities a WHERE a.owner_id=NEW.owner_id AND a.namespace=NEW.namespace AND a.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'timer_work_kind_conflict'); END;
CREATE TRIGGER ordinary_input_refuses_tracker_scan BEFORE INSERT ON dormant_timer_inputs
WHEN EXISTS(SELECT 1 FROM tracker_scan_authorities a WHERE a.owner_id=NEW.owner_id AND a.namespace=NEW.namespace AND a.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'timer_work_kind_conflict'); END;

CREATE TABLE tracker_scan_attempts (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, namespace TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0), conversation_id TEXT NOT NULL,
 authority_id TEXT NOT NULL, due_ms INTEGER NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0),
 source_revision INTEGER NOT NULL CHECK(source_revision>0),
 classifier_digest TEXT NOT NULL CHECK(length(classifier_digest)=64),
 stop_sequence INTEGER NOT NULL CHECK(stop_sequence>=0), deadline_ms INTEGER NOT NULL,
 issuer_key TEXT NOT NULL CHECK(length(issuer_key)=64),
 state TEXT NOT NULL CHECK(state IN('reading','committed','expired','failed')),
 created_ms INTEGER NOT NULL, CHECK(deadline_ms>created_ms),
 UNIQUE(owner_id,namespace,generation,due_ms,attempt),
 UNIQUE(id,owner_id,conversation_id),
 UNIQUE(id,owner_id,namespace,generation,conversation_id,due_ms),
 FOREIGN KEY(authority_id,owner_id,namespace,generation,conversation_id) REFERENCES tracker_scan_authorities(authority_id,owner_id,namespace,generation,conversation_id),
 FOREIGN KEY(owner_id,conversation_id,source_revision) REFERENCES tracker_source_selections(owner_id,conversation_id,source_revision)
);
CREATE UNIQUE INDEX tracker_one_read_attempt ON tracker_scan_attempts(owner_id,conversation_id) WHERE state='reading';
CREATE TRIGGER tracker_attempt_provenance BEFORE UPDATE ON tracker_scan_attempts
WHEN OLD.state<>'reading' OR NEW.state NOT IN('committed','expired','failed')
 OR NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.namespace<>OLD.namespace
 OR NEW.generation<>OLD.generation OR NEW.conversation_id<>OLD.conversation_id
 OR NEW.authority_id<>OLD.authority_id OR NEW.due_ms<>OLD.due_ms OR NEW.attempt<>OLD.attempt
 OR NEW.source_revision<>OLD.source_revision OR NEW.classifier_digest<>OLD.classifier_digest
 OR NEW.stop_sequence<>OLD.stop_sequence OR NEW.deadline_ms<>OLD.deadline_ms
 OR NEW.issuer_key<>OLD.issuer_key OR NEW.created_ms<>OLD.created_ms
BEGIN SELECT RAISE(ABORT,'immutable_tracker_attempt_provenance'); END;
CREATE TRIGGER tracker_attempt_no_delete BEFORE DELETE ON tracker_scan_attempts
BEGIN SELECT RAISE(ABORT,'immutable_tracker_attempt_provenance'); END;

CREATE UNIQUE INDEX tracker_canonical_claim_scope ON dormant_timer_claims(claim_id,owner_id,namespace,generation,conversation_id,due_ms);
CREATE TABLE tracker_scan_receipts (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,namespace TEXT NOT NULL,generation INTEGER NOT NULL,
 conversation_id TEXT NOT NULL,due_ms INTEGER NOT NULL,attempt_id TEXT NOT NULL UNIQUE,claim_id TEXT NOT NULL UNIQUE,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 result_digest TEXT NOT NULL CHECK(length(result_digest)=64),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),recorded_ms INTEGER NOT NULL,
 UNIQUE(owner_id,namespace,generation,due_ms),UNIQUE(owner_id,conversation_id,request_key),
 UNIQUE(id,owner_id,conversation_id),
 FOREIGN KEY(attempt_id,owner_id,namespace,generation,conversation_id,due_ms) REFERENCES tracker_scan_attempts(id,owner_id,namespace,generation,conversation_id,due_ms),
 FOREIGN KEY(claim_id,owner_id,namespace,generation,conversation_id,due_ms) REFERENCES dormant_timer_claims(claim_id,owner_id,namespace,generation,conversation_id,due_ms)
);
CREATE TRIGGER tracker_scan_receipt_no_update BEFORE UPDATE ON tracker_scan_receipts
BEGIN SELECT RAISE(ABORT,'immutable_tracker_scan_result'); END;
CREATE TRIGGER tracker_scan_receipt_no_delete BEFORE DELETE ON tracker_scan_receipts
BEGIN SELECT RAISE(ABORT,'immutable_tracker_scan_result'); END;
-- UI-only reports. The WhatsApp adapter's timer_digests queue is untouched.
CREATE TABLE tracker_action_digests (
 id TEXT PRIMARY KEY,action_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,created_ms INTEGER NOT NULL,
 FOREIGN KEY(action_id,owner_id,conversation_id) REFERENCES tracker_scan_receipts(id,owner_id,conversation_id)
);
CREATE TRIGGER tracker_action_digest_no_update BEFORE UPDATE ON tracker_action_digests
BEGIN SELECT RAISE(ABORT,'immutable_tracker_action_digest'); END;
CREATE TRIGGER tracker_action_digest_no_delete BEFORE DELETE ON tracker_action_digests
BEGIN SELECT RAISE(ABORT,'immutable_tracker_action_digest'); END;

-- A request and its cancellation are separate immutable decisions. A negative
-- cancellation may arrive before creation and permanently blocks that key.
CREATE TABLE tracker_manual_checks (
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL CHECK(length(semantic_digest)=64),
 namespace TEXT NOT NULL UNIQUE, authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
 created_ms INTEGER NOT NULL, PRIMARY KEY(owner_id,conversation_id,request_key),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES trackers(owner_id,conversation_id),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
CREATE TABLE tracker_check_cancellations (
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, request_key TEXT NOT NULL,
 created_ms INTEGER NOT NULL, PRIMARY KEY(owner_id,conversation_id,request_key),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES trackers(owner_id,conversation_id)
);
CREATE TRIGGER tracker_manual_check_no_update BEFORE UPDATE ON tracker_manual_checks
BEGIN SELECT RAISE(ABORT,'immutable_tracker_manual_check'); END;
CREATE TRIGGER tracker_manual_check_no_delete BEFORE DELETE ON tracker_manual_checks
BEGIN SELECT RAISE(ABORT,'immutable_tracker_manual_check'); END;
CREATE TRIGGER tracker_check_cancel_no_update BEFORE UPDATE ON tracker_check_cancellations
BEGIN SELECT RAISE(ABORT,'immutable_tracker_check_cancel'); END;
CREATE TRIGGER tracker_check_cancel_no_delete BEFORE DELETE ON tracker_check_cancellations
BEGIN SELECT RAISE(ABORT,'immutable_tracker_check_cancel'); END;
