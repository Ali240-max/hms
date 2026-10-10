-- Inpatients: wards, beds, admissions.
--
-- An admission is a visit that does not end the same day. Everything a ward
-- does hangs off it: the bed, the doctor's rounds, the tests ordered from the
-- bedside, the medicines, and one running account the family settles at the
-- end.
--
-- THE RULE THAT DECIDES EVERYTHING HERE: a bed is charged per night. A patient
-- admitted at 11pm and discharged at 9am the next morning has slept one night
-- and pays for one. Admitted and discharged the same day is a day case, and
-- charges one night rather than none, because the bed was held and could not
-- be given to anybody else. Both of those are written down because every other
-- way of counting gives a different bill for the same stay, and the argument
-- at the counter is always about this.
--
-- ONE TRANSACTION PER FILE.

/* ------------------------------------------------------------- wards */

CREATE TABLE IF NOT EXISTS wards (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  -- general | private | semi_private | icu | nursery | labour | isolation
  -- Free text rather than an enum: a hospital adds "Post-Op" or "Day Care"
  -- and should not need a migration to do it.
  kind          text NOT NULL DEFAULT 'general',
  floor         text,
  /*
   * The nightly charge every bed in this ward inherits.
   *
   * A general ward is one price for twenty beds, so the price lives here. A
   * private room is priced individually, which is what the per-bed override
   * below is for: "add options to specify their charges separately".
   */
  charge_paisa  integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wards_name_uq ON wards (lower(name));

/* -------------------------------------------------------------- beds */

CREATE TABLE IF NOT EXISTS beds (
  id            serial PRIMARY KEY,
  ward_id       integer NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  -- "B-07", "ICU-2", "Room 14". Unique within its ward, not across the
  -- hospital: every ward numbers its own beds from one.
  name          text NOT NULL,
  /*
   * Null means "whatever the ward charges".
   *
   * Set only where a bed is priced differently from its ward, which in
   * practice means private rooms. Storing the ward price on every bed would
   * mean a price rise had to be applied twenty times and would be applied
   * nineteen.
   */
  charge_paisa  integer,
  -- free | occupied | reserved | cleaning | out_of_service
  status        text NOT NULL DEFAULT 'free',
  note          text,
  is_active     boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS beds_ward_name_uq ON beds (ward_id, lower(name));
CREATE INDEX IF NOT EXISTS beds_status_idx ON beds (status);

/* -------------------------------------------------------- admissions */

CREATE TABLE IF NOT EXISTS admissions (
  id                serial PRIMARY KEY,
  admission_no      text NOT NULL,
  patient_id        integer NOT NULL REFERENCES patients(id),
  -- The OPD or emergency visit it came from, where it came from one.
  visit_id          integer REFERENCES visits(id),
  doctor_id         integer REFERENCES doctors(id),
  department_id     integer REFERENCES departments(id),

  -- planned | emergency | day_case | delivery
  admission_type    text NOT NULL DEFAULT 'planned',
  diagnosis         text,
  final_diagnosis   text,

  -- Who the ward actually telephones.
  attendant_name    text,
  attendant_phone   text,
  attendant_relation text,

  admitted_at       timestamptz NOT NULL DEFAULT now(),
  discharged_at     timestamptz,
  -- discharged | referred | lama | death
  -- LAMA and death are not edge cases in a hospital. A system that models
  -- only a tidy discharge gets worked around on the worst days.
  outcome           text,
  outcome_note      text,

  -- open | discharged | cancelled
  status            text NOT NULL DEFAULT 'open',

  admitted_by       text,
  discharged_by     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admissions_no_uq ON admissions (admission_no);
CREATE INDEX IF NOT EXISTS admissions_status_idx ON admissions (status, admitted_at);
CREATE INDEX IF NOT EXISTS admissions_patient_idx ON admissions (patient_id);

/* -------------------------------------------------- where they slept */

/*
 * One row per stretch in one bed.
 *
 * A patient moved from the general ward to a private room on day three has
 * two rows, and the bill adds up two nights at one rate and two at another.
 * Keeping the bed on the admission instead would make the bill wrong the
 * moment anybody was moved, and patients are moved constantly.
 *
 * The rate is COPIED here at the time of assignment rather than read from the
 * ward later. A ward whose price goes up in March must not silently re-price
 * a stay from January.
 */
CREATE TABLE IF NOT EXISTS bed_stays (
  id            serial PRIMARY KEY,
  admission_id  integer NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  bed_id        integer NOT NULL REFERENCES beds(id),
  charge_paisa  integer NOT NULL,
  from_at       timestamptz NOT NULL DEFAULT now(),
  to_at         timestamptz,
  reason        text,
  moved_by      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bed_stays_admission_idx ON bed_stays (admission_id, from_at);
CREATE INDEX IF NOT EXISTS bed_stays_bed_idx ON bed_stays (bed_id, to_at);

/* ------------------------------------------------- the running account */

/*
 * Everything the admission accrues, one row at a time.
 *
 * Bed nights, doctor rounds, procedures, and anything billed from the lab,
 * pharmacy or stores to the bedside. Written as it happens rather than
 * calculated at discharge, so an interim bill on day three is the same
 * arithmetic as the final one and the family can be told a number at any
 * point.
 */
CREATE TABLE IF NOT EXISTS admission_charges (
  id            serial PRIMARY KEY,
  admission_id  integer NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  -- bed | doctor | procedure | lab | radiology | pharmacy | supplies | other
  kind          text NOT NULL,
  description   text NOT NULL,
  qty           numeric(10, 2) NOT NULL DEFAULT 1,
  unit_paisa    integer NOT NULL DEFAULT 0,
  total_paisa   integer NOT NULL DEFAULT 0,
  -- What it came from, where it came from something: a service order, a
  -- sale, an issue note. Kept so a line can be traced back and so the same
  -- thing is never billed twice.
  source_table  text,
  source_id     integer,
  charged_for   date,
  added_by      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admission_charges_admission_idx
  ON admission_charges (admission_id, created_at);

/*
 * A bed night is charged once per night, however many times anything runs.
 *
 * The nightly posting is the one piece of this that happens on a timer rather
 * than because somebody pressed a button, so it is the one that will be run
 * twice. This index makes the second run impossible rather than merely
 * unlikely.
 */
CREATE UNIQUE INDEX IF NOT EXISTS admission_charges_bed_night_uq
  ON admission_charges (admission_id, charged_for)
  WHERE kind = 'bed';

/* --------------------------------------------------- money taken in */

CREATE TABLE IF NOT EXISTS admission_payments (
  id            serial PRIMARY KEY,
  admission_id  integer NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  -- advance | payment | refund | discount | waived
  kind          text NOT NULL DEFAULT 'payment',
  amount_paisa  integer NOT NULL,
  method        text,
  note          text,
  -- A discount or a waiver needs a name against it. They are the two lines on
  -- an inpatient bill that cost the hospital money without anything arriving.
  approved_by   text,
  taken_by      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admission_payments_admission_idx
  ON admission_payments (admission_id, created_at);
