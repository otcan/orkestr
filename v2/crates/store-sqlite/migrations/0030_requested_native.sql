-- Protocol initialization is not evidence that a native session was observed.
-- Each setup generation must observe its own matching system/init before Started.
CREATE TABLE production_requested_native (
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 requested_native_id TEXT NOT NULL,
 initialization_key TEXT NOT NULL,
 observed_run_id TEXT REFERENCES production_runs(id),
 observed_event_key TEXT,
 PRIMARY KEY(session_id,binding_generation),
 CHECK((observed_run_id IS NULL AND observed_event_key IS NULL)
    OR (observed_run_id IS NOT NULL AND observed_event_key IS NOT NULL))
);
