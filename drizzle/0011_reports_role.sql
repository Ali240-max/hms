-- A read-only reports desk.
--
-- Hospitals here have an accounts person who is asked for figures from every
-- department and should not be given a till, a prescription pad or the power
-- to change a price to get them. Giving that person an administrator account
-- is what usually happens, and it is how prices quietly change.
--
-- This role can open every report in the system and nothing else.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'reports';
