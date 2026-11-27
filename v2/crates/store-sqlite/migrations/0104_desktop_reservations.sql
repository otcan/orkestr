-- Desk reservations between single-step leases (orkestr_v2_contracts::
-- desktop_reservations). A desk has at most one claim (a chat's `task`, or
-- `owner_handoff`: a chat handed it to the owner) and at most one
-- `owner_viewer` window (the owner opened a viewing link). The acquire that
-- they guard reads them in its own transaction. Expiry is `until_ms`: a row
-- past it counts as none and the owner's next write deletes it. Additive: no
-- existing row changes, and a server without this table ignores it.
CREATE TABLE desktop_reservations (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 desktop_slug TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('task','owner_handoff','owner_viewer')),
 conversation_id TEXT,
 since_ms INTEGER NOT NULL,
 until_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 CHECK((kind = 'owner_viewer') = (conversation_id IS NULL)),
 CHECK(until_ms > since_ms),
 FOREIGN KEY(conversation_id, owner_id) REFERENCES conversations(id, owner_id)
);
CREATE UNIQUE INDEX desktop_reservations_one_claim ON desktop_reservations(owner_id, desktop_slug)
 WHERE kind IN ('task','owner_handoff');
CREATE UNIQUE INDEX desktop_reservations_one_viewer ON desktop_reservations(owner_id, desktop_slug)
 WHERE kind = 'owner_viewer';
CREATE INDEX desktop_reservations_until ON desktop_reservations(owner_id, until_ms);
