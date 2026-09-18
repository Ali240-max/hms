-- The laboratory, and what a test consumes.
--
-- A lab order is not a new charge. It is the working life of a service_order
-- that has already been ordered by a doctor and paid for at the counter:
-- sample taken, test run, result entered, report handed over. Keeping it in
-- its own table means the money side stays exactly as it was and the lab can
-- gain states without the billing code noticing.
--
-- The gate is payment. Nothing can be collected or run until the underlying
-- service_order reads 'paid', which happens when the chit is settled.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'lab_tech';

-- What a test reports. A CBC has a dozen lines, a blood sugar has one. Held
-- against the service so the form the technician fills in writes itself, and
-- so reference ranges live in one place rather than being retyped per patient.
CREATE TABLE IF NOT EXISTS service_parameters (
  id             serial PRIMARY KEY,
  service_id     integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name           text NOT NULL,
  unit           text,
  -- Numeric range where there is one. Some results are words, not numbers:
  -- blood group, culture growth, presence of protein. Those use ref_text.
  ref_low        numeric(12,3),
  ref_high       numeric(12,3),
  ref_text       text,
  display_order  integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS service_parameters_service_idx
  ON service_parameters (service_id, display_order);

-- What running the test uses up. One CBC costs a syringe, two vials and a
-- pair of gloves; recording that is what lets the store see consumption
-- without anyone remembering to issue against each test by hand.
CREATE TABLE IF NOT EXISTS service_consumables (
  id          serial PRIMARY KEY,
  service_id  integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  item_id     integer NOT NULL REFERENCES supply_items(id) ON DELETE CASCADE,
  qty         integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS service_consumables_uq
  ON service_consumables (service_id, item_id);

CREATE TABLE IF NOT EXISTS lab_orders (
  id                serial PRIMARY KEY,
  report_no         text NOT NULL,
  service_order_id  integer NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  visit_id          integer NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  patient_id        integer NOT NULL REFERENCES patients(id),

  -- pending -> collected -> in_progress -> resulted
  status            text NOT NULL DEFAULT 'pending',

  sample_type       text,
  collected_at      timestamptz,
  collected_by      text,
  started_at        timestamptz,
  started_by        text,
  resulted_at       timestamptz,
  resulted_by       text,
  -- A second signature. Many labs want the result checked before it is given
  -- to a patient, and the report prints whoever verified it.
  verified_at       timestamptz,
  verified_by       text,

  notes             text,
  /** Set once the consumables have been taken off the store, so a re-save
      cannot deduct them twice. */
  supplies_taken_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lab_orders_report_no_uq ON lab_orders (report_no);
CREATE UNIQUE INDEX IF NOT EXISTS lab_orders_service_uq   ON lab_orders (service_order_id);
CREATE INDEX        IF NOT EXISTS lab_orders_status_idx   ON lab_orders (status, created_at);
CREATE INDEX        IF NOT EXISTS lab_orders_visit_idx    ON lab_orders (visit_id);

-- The measured values. Copied from the parameter rather than joined, so that
-- editing a reference range next year does not silently rewrite what a report
-- issued today said.
CREATE TABLE IF NOT EXISTS lab_values (
  id             serial PRIMARY KEY,
  lab_order_id   integer NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  name           text NOT NULL,
  value          text,
  unit           text,
  ref_text       text,
  flag           text,
  display_order  integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS lab_values_order_idx ON lab_values (lab_order_id, display_order);
