-- Pharmacy credit bills that can be settled, and bills issued to departments.
--
-- 1. sale_payments: money received AGAINST ONE CREDIT BILL after it was
--    made. A credit bill used to be a dead end: the till wrote it, nothing
--    could ever mark it paid, and the till even stored paid_paisa = total,
--    so every "collected" figure counted money that never came in. A payment
--    is its own row — dated, with who took it — rather than an overwrite of
--    the bill, so the bill stays exactly as it was billed and the day the
--    money arrived is the day it counts as collected.
--
-- 2. sales.department_id: a bill issued to a hospital department (OT,
--    Emergency…). A real foreign key to departments, not the name in
--    customer_name, so the report groups by the department and a rename does
--    not split one department's bills in two.
--
-- 3. sales.request_key: a key the screen generates once per bill, so a
--    double click or a retry after a dropped connection returns the bill that
--    was already made instead of taking the stock off the shelf twice.
--
-- Nothing existing is rewritten. Old credit bills keep their paid_paisa;
-- what is outstanding is worked out from sale_payments.
--
-- ONE TRANSACTION PER FILE.

CREATE TABLE IF NOT EXISTS sale_payments (
  id                    serial PRIMARY KEY,
  sale_id               integer NOT NULL REFERENCES sales(id),
  amount_paisa          bigint NOT NULL CHECK (amount_paisa > 0),
  method                text NOT NULL DEFAULT 'cash',
  -- What was owed when this was taken, so a statement can be rebuilt and a
  -- second press of the same confirmation can be recognised and refused.
  outstanding_before_paisa bigint NOT NULL,
  reference             text,
  note                  text,
  -- The party voucher, when the bill was on a customer account with a
  -- ledger, so the ledger and the bill tell the same story.
  payment_id            integer REFERENCES payments(id),
  received_by           text NOT NULL,
  received_by_staff_id  integer REFERENCES staff(id),
  received_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sale_payments_sale_idx ON sale_payments (sale_id);
CREATE INDEX IF NOT EXISTS sale_payments_when_idx ON sale_payments (received_at);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS department_id integer REFERENCES departments(id);
CREATE INDEX IF NOT EXISTS sales_department_idx ON sales (department_id, sold_at)
  WHERE department_id IS NOT NULL;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS request_key text;
CREATE UNIQUE INDEX IF NOT EXISTS sales_request_key_uq ON sales (request_key)
  WHERE request_key IS NOT NULL;
