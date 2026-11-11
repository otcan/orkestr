-- Owner-level desk sharing (ORK-773). No row means off (revision 0): a chat
-- reaches only the desks its desktop binding lists. On: any desk may be
-- reserved through any chat's desktop binding. Lease rows, one holder per
-- desk and fencing are unchanged.
CREATE TABLE desktop_sharing (
 owner_id TEXT PRIMARY KEY REFERENCES owners(id),
 share_all_desks INTEGER NOT NULL CHECK(share_all_desks IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision > 0),
 updated_at_ms INTEGER NOT NULL
);
