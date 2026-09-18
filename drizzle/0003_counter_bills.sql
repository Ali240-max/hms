-- Counter billing, and two more stages in a visit's life.
--
-- A visit no longer joins the queue the moment it is created. It is
-- 'registered' until the cashier completes the bill, which is what actually
-- happens: a patient standing at the window with an unpaid slip is not in the
-- queue yet. Once billed it becomes 'waiting'; once the OPD desk has taken
-- details and sent them in it becomes 'ready', and only then may a doctor open
-- it.
--
-- ONE TRANSACTION PER FILE. Enum values are added here and used only by later
-- migrations and by application code, never in this same transaction.

ALTER TYPE visit_status ADD VALUE IF NOT EXISTS 'registered' BEFORE 'waiting';
ALTER TYPE visit_status ADD VALUE IF NOT EXISTS 'ready' AFTER 'waiting';

ALTER TABLE visits ADD COLUMN IF NOT EXISTS sent_in_at timestamptz;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS sent_in_by text;

-- Every rupee taken at the main counter window, consultation or chit alike.
-- One row per bill the cashier completes, so the drawer can be reconciled
-- against printed invoices rather than against a status flag on another table.
CREATE TABLE IF NOT EXISTS counter_bills (
  id                serial PRIMARY KEY,
  bill_no           text NOT NULL,
  kind              text NOT NULL,
  visit_id          integer REFERENCES visits(id) ON DELETE SET NULL,
  patient_id        integer REFERENCES patients(id),
  chit_id           integer REFERENCES chits(id) ON DELETE SET NULL,
  subtotal_paisa    bigint NOT NULL DEFAULT 0,
  discount_paisa    bigint NOT NULL DEFAULT 0,
  total_paisa       bigint NOT NULL DEFAULT 0,
  tendered_paisa    bigint NOT NULL DEFAULT 0,
  change_paisa      bigint NOT NULL DEFAULT 0,
  pay_method        pay_method NOT NULL DEFAULT 'cash',
  cashier_staff_id  integer REFERENCES staff(id),
  cashier_name      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS counter_bills_no_uq     ON counter_bills (bill_no);
CREATE INDEX        IF NOT EXISTS counter_bills_visit_idx ON counter_bills (visit_id);
CREATE INDEX        IF NOT EXISTS counter_bills_made_idx  ON counter_bills (created_at);
CREATE INDEX        IF NOT EXISTS counter_bills_chit_idx  ON counter_bills (chit_id);

CREATE TABLE IF NOT EXISTS counter_bill_items (
  id            serial PRIMARY KEY,
  bill_id       integer NOT NULL REFERENCES counter_bills(id) ON DELETE CASCADE,
  description   text NOT NULL,
  ref_type      text,
  ref_id        integer,
  amount_paisa  bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS counter_bill_items_bill_idx ON counter_bill_items (bill_id);
