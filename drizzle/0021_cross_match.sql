-- Cross match reports.
--
-- Before a transfusion the laboratory checks that a specific bag of blood is
-- safe for a specific patient. The report names both sides, records the
-- donor's screening for the four infections that are always tested, and ends
-- with whether the match is compatible.
--
-- It is kept apart from ordinary lab orders on purpose. A normal report has
-- parameters and reference ranges; this one has a fixed set of questions with
-- fixed answers, it concerns two people rather than one, and its conclusion is
-- a clinical decision rather than a number. Forcing it into the parameters
-- table would mean a free-text field called "Blood Bag no." with a reference
-- range beside it.
--
-- ONE TRANSACTION PER FILE.

CREATE TABLE IF NOT EXISTS cross_matches (
  id              serial PRIMARY KEY,
  report_no       text NOT NULL,
  patient_id      integer NOT NULL REFERENCES patients(id),
  visit_id        integer REFERENCES visits(id),

  -- The patient's side.
  patient_group   text,
  patient_rh      text,

  -- The donor's side. A donor is not a patient of the hospital and is not
  -- registered as one, so their details live here rather than in patients.
  donor_name      text NOT NULL,
  donor_age       integer,
  donor_sex       text,
  donor_group     text,
  donor_rh        text,
  donor_hb        text,
  blood_bag_no    text,

  -- Screening. Free text rather than a boolean: a laboratory writes
  -- "NEGATIVE", "NON REACTIVE" and occasionally "NOT DONE", and flattening
  -- those to true or false loses the difference between a clear result and a
  -- test nobody ran.
  hbsag           text,
  anti_hcv        text,
  hiv             text,
  vdrl            text,
  mp              text,

  direct_phase    text,
  albumin_phase   text,

  conclusion      text,
  notes           text,

  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cross_matches_patient_idx ON cross_matches (patient_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS cross_matches_no_uq ON cross_matches (report_no);
