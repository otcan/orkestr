-- Read-path indexes only: no table, row or constraint changes.
--
-- The sidebar's newest-archived-message lookup ordered every archived
-- message of a source in a temporary B-tree (tens of thousands of rows for
-- an imported V1 thread) once per conversation on every sidebar poll.
CREATE INDEX archived_history_messages_created
 ON archived_history_messages(source_row,created_at);

-- Progress payloads by run: native sidebar previews, accepted results and
-- execution status looked them up by scanning every stored payload.
CREATE INDEX production_payloads_run ON production_payloads(run_id,owner_id);
