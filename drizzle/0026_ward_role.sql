-- A login for the ward.
--
-- Inpatients are not a tab inside the counter. The ward is a different room,
-- a different shift and a different person: a nurse at the nursing station
-- needs the bed board and the admission in front of her and nothing else, and
-- a cashier should not be scrolling past twenty beds to reach the till.
--
-- So it is its own role with its own screen, the way the laboratory and the
-- pharmacy are.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'ward';
