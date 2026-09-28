-- What a printed lab report carries beyond the numbers.
--
-- Three things a real report has and ours did not:
--
--   * an interpretation table, the block under a result that says what the
--     figure means — "Deficiency <20, Sufficiency 21-30, Desirable 31-100".
--     It belongs to the test, not to the result, because it is the same on
--     every copy.
--   * a free note with its own heading, for whatever the technician needs to
--     say about that particular report.
--   * the signatures along the foot: a pathologist, a technologist, each with
--     their qualifications, registration number and a scanned signature.
--
-- The signatures are hospital-wide settings rather than per-report, because
-- the same two or three people sign everything.
--
-- ONE TRANSACTION PER FILE.

CREATE TABLE IF NOT EXISTS service_interpretations (
  id            serial PRIMARY KEY,
  service_id    integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  -- "Vitamin D Deficiency"
  title         text NOT NULL,
  -- "< 20 ng/ml". Free text on purpose: these are written the way a
  -- laboratory writes them, and forcing them into numbers would lose
  -- "Adults: 30 - 115" and "Upto 15 Years: < 345".
  range_text    text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_interpretations_service_idx
  ON service_interpretations (service_id, display_order);

-- The people who sign reports. Ordered left to right along the foot.
CREATE TABLE IF NOT EXISTS lab_signatories (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  -- "MBBS, MPhil Microbiology" on one line, "Consultant Pathologist" the next
  qualification  text,
  designation    text,
  -- "PMDC 54763-P"
  registration   text,
  -- A scanned signature as a data URI, printed above the name.
  signature      text,
  display_order  integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('lab.noteHeading', 'Note'),
  ('lab.noteDefault', ''),
  ('lab.logoPosition', 'right')
ON CONFLICT (key) DO NOTHING;
