-- Enable-time floor of a dormant timer's next occurrence. A timer handed off
-- from V1 has no V2 claim history, so after V1 fired a top-of-the-hour slot at
-- its raw time, a V2 enable inside that slot's spread window (up to 8 min)
-- would schedule the same slot again at its spread time. Every enable now
-- records its time here; a natural slot at or before it is never scheduled,
-- also not by a later pause refresh or calendar edit. NULL for rows enabled
-- before this schema: their claim history is the only floor, as before.
ALTER TABLE dormant_timers ADD COLUMN enable_floor_ms INTEGER
 CHECK(enable_floor_ms IS NULL OR enable_floor_ms >= 0);
