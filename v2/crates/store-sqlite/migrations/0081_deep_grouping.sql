-- Owner switch for Deep burst grouping, read live at each Deep admission.
-- Default on: owner inputs that queued while Deep was busy are taken by the
-- next Deep turn together (each consumed by that one run, recorded as its
-- `reasoning_inbox.admitted_run_id`). Off means one Deep turn per queued
-- input, exactly as before this schema. Additive only.
-- Takes 0081: the held timer change (#372) must renumber after this one if
-- revived (store preflight requires the applied migrations to be a prefix
-- of the source list).
ALTER TABLE conversation_settings ADD COLUMN deep_grouping INTEGER NOT NULL DEFAULT 1
 CHECK(deep_grouping IN (0,1));
