-- Timer ordinary input provenance and shared eligibility fences.
CREATE TABLE dormant_timer_input_guards (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), stop_sequence INTEGER NOT NULL CHECK(stop_sequence>=0),
 request_key TEXT NOT NULL, PRIMARY KEY(owner_id,namespace,generation),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
CREATE TABLE dormant_timer_inputs (
 claim_id TEXT PRIMARY KEY REFERENCES dormant_timer_claims(claim_id),
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, generation INTEGER NOT NULL,
 input_digest TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 event_id TEXT NOT NULL UNIQUE REFERENCES events(id), scope_sequence INTEGER NOT NULL,
 FOREIGN KEY(owner_id,namespace,generation) REFERENCES dormant_timer_input_guards(owner_id,namespace,generation)
);
CREATE VIEW ordinary_input_holds AS
 SELECT event_id FROM production_held_inputs
 UNION
 SELECT i.event_id FROM dormant_timer_inputs i
 JOIN dormant_timer_claims c ON c.claim_id=i.claim_id
 JOIN dormant_timers t ON t.owner_id=i.owner_id AND t.namespace=i.namespace
 WHERE c.cancelled=1 OR c.generation!=i.generation OR t.generation!=i.generation
    OR t.state NOT IN ('enabled','exhausted');
