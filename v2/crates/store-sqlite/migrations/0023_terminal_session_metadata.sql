-- The reservation may identify owner acceptance or an exact confirmed Stopped event.
-- Historical reservations retain their event FK and one-use predecessor uniqueness.
ALTER TABLE production_resume_metadata RENAME COLUMN acceptance_event_id TO terminal_event_id;
