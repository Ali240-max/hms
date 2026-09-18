-- Payment chits: the paper a patient carries from reception to the cashier and
-- then to the department. One per department per visit.
--
-- ONE TRANSACTION PER FILE. The runner wraps this; nothing here may break it
-- half way, or the install is left in a state no later migration can repair.

CREATE TABLE IF NOT EXISTS chits (
  id            serial PRIMARY KEY,
  chit_no       text NOT NULL,
  visit_id      integer NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  patient_id    integer NOT NULL REFERENCES patients(id),
  category      service_category NOT NULL,
  total_paisa   bigint NOT NULL DEFAULT 0,
  status        order_status NOT NULL DEFAULT 'ordered',
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz,
  paid_by       text,
  pay_method    pay_method,
  completed_at  timestamptz,
  completed_by  text,
  note          text
);

CREATE UNIQUE INDEX IF NOT EXISTS chits_chit_no_uq   ON chits (chit_no);
CREATE INDEX        IF NOT EXISTS chits_visit_idx    ON chits (visit_id);
CREATE INDEX        IF NOT EXISTS chits_status_idx   ON chits (status);
CREATE INDEX        IF NOT EXISTS chits_created_idx  ON chits (created_at);

-- Which chit a given ordered test was printed on. Null until reception prints.
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS chit_id integer;
CREATE INDEX IF NOT EXISTS service_orders_chit_idx ON service_orders (chit_id);
