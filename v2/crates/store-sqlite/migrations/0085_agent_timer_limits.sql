-- Per-conversation daily create cap of agent timers (owner setting). Additive
-- only. No row: the server default (`ORKESTR_V2_AGENT_TIMER_DAILY_CREATES_MAX`,
-- 24). `owner_only`: the server's owner-only default (200). `fixed`: exactly
-- daily_creates_max. `off`: no daily cap. The hourly create cap, the live
-- timer cap and the schedule caps always apply.
CREATE TABLE agent_timer_limits (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('owner_only','fixed','off')),
 daily_creates_max INTEGER CHECK((mode='fixed' AND daily_creates_max BETWEEN 1 AND 10000) OR (mode!='fixed' AND daily_creates_max IS NULL)),
 updated_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
