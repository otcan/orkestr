-- Audit of owner acceptances made by the server's system principal acting for
-- the owner (owner auto-accept, V1 behaviour). A row exists only when the
-- conversation's `review_before_accepting` was off and the acceptance was
-- authorized by the live execution window's private credential. Browser
-- (owner) acceptances have no row here.
CREATE TABLE production_auto_acceptances (
 run_id TEXT PRIMARY KEY REFERENCES production_acceptances(run_id),
 actor TEXT NOT NULL CHECK(actor='auto_accept'),
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 settings_revision INTEGER NOT NULL CHECK(settings_revision>=0)
);
