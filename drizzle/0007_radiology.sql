-- Radiology as its own department.
--
-- An x-ray room and a blood lab share a workflow — ordered, paid, performed,
-- reported — and nothing else. Different staff, different rooms, different
-- machines, and a radiographer scrolling past forty blood tests to find their
-- two chest films is the kind of friction that makes people stop using a
-- system. So they get their own login and their own list, over the same
-- tables.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'radiology';

-- Tests bought without a consultation.
--
-- Somebody walks in with a form from another hospital, or wants a sugar test
-- before Ramadan, or an employer wants a blood group. Making them sit through
-- a consultation to buy one test sends that trade to the lab across the road.
--
-- Such a visit has no doctor, so the column has to allow it. Nothing else
-- changes: the chit, the lab work list and the report all read a visit the
-- same way. A null doctor also keeps these out of the earnings tables
-- automatically, which is correct — nobody referred them.
ALTER TABLE visits ALTER COLUMN doctor_id DROP NOT NULL;

-- Same reason on the order itself. The doctor is who gets a share of it, and
-- for a walk-in test there is nobody to pay.
ALTER TABLE service_orders ALTER COLUMN doctor_id DROP NOT NULL;
