-- Emergency (IPD) intake.
--
-- Emergency runs the opposite way round to OPD. In OPD the patient pays first
-- and is then seen; in emergency they are seen first and the money is sorted
-- out afterwards, because nobody sends a bleeding patient to a cash window.
-- The visit is therefore created straight away by the emergency desk and shows
-- up at the main counter as something owed, not as something to collect before
-- treatment starts.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'ipd_counter';

-- 'opd' or 'emergency'. Text rather than an enum: this is the sort of list a
-- hospital adds to (day care, dressing room), and adding an enum value needs
-- its own migration and cannot be used in the same transaction.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS visit_type text NOT NULL DEFAULT 'opd';

-- How sick they are, set at the door. Drives the order of the emergency list.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS triage text;

-- Free-text note taken at the emergency door, before any doctor sees them.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS arrival_note text;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS brought_by text;

CREATE INDEX IF NOT EXISTS visits_type_idx ON visits (visit_type, created_at);
