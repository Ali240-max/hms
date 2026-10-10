-- A normal value written as an operator and a number.
--
-- "< 0.50" was free text, so nothing could compare a result against it and
-- those tests never showed high or low at all. Split into an operator and a
-- number, the comparison is arithmetic again: a result of 0.80 against
-- "< 0.50" is high, and says so.
--
-- Free text stays for the cases that are genuinely prose, such as
-- "Upto 15 Years: < 345". Where the operator is set it wins, because it is
-- the more precise statement of the same thing.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE service_parameters
  ADD COLUMN IF NOT EXISTS ref_op    text,
  ADD COLUMN IF NOT EXISTS ref_value numeric(14, 4);
