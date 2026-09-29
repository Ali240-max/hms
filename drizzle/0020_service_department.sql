-- Which department a service belongs to.
--
-- A service carried only a broad category — consultation, lab, radiology —
-- which is enough to route it to the right screen and not enough to report
-- on. "Department Summary" could show the laboratory as one line but could
-- not split an ECG from an X-ray, because nothing said which department owns
-- which procedure.
--
-- Nullable, and reports fall back to the category when it is not set, so
-- nothing has to be filled in before the existing reports keep working.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS department_id integer REFERENCES departments(id);

CREATE INDEX IF NOT EXISTS services_department_idx ON services (department_id);
