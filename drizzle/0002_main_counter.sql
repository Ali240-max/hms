-- The counter split, and the vitals the OPD desk records.
--
-- Two desks, not one. The main counter registers patients, takes consultation
-- fees and settles chits — all the money. The OPD counter handles the clinical
-- side: it sees the queue, records what the patient came in with, and sends
-- them through to the doctor. Neither can do the other's job.
--
-- ONE TRANSACTION PER FILE. Adding an enum value is allowed inside one; using
-- it in the same transaction is not, which is why nothing below references
-- 'main_counter'.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'main_counter';

-- Recorded at the OPD counter before the doctor sees the patient. Kept on the
-- visit rather than the patient: these are readings from one day, not facts
-- about a person, and the doctor needs to see what they were on arrival.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS bp_systolic    integer;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS bp_diastolic   integer;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS pulse_bpm      integer;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS temperature_f  numeric(4,1);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS weight_kg      numeric(5,1);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS sugar_mg_dl    integer;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS vitals_note    text;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS vitals_by      text;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS vitals_at      timestamptz;
