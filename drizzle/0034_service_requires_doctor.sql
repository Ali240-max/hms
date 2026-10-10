-- A service that cannot be billed without naming a doctor.
--
-- Procedures are the reason. A dressing, a nebulisation, an ECG, a stitch
-- removal — somebody performs these, and the person who performs them has a
-- share in them. Billed with no doctor named, the share has nowhere to go and
-- is quietly lost; a month later the doctor asks why their earnings are short
-- and there is nothing on the record to answer with.
--
-- It is a flag per service rather than a rule about the `procedure` category,
-- because the two do not line up. Some procedures are done by a nurse and
-- need no doctor at all, and some tests in a small hospital genuinely are
-- performed by a named consultant. The person setting the service up knows
-- which; the category does not.
--
-- Defaults FALSE, so nothing that is billed today changes behaviour. Turning
-- it on is a deliberate act per service.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS requires_doctor boolean NOT NULL DEFAULT false;

/*
 * Procedures are the common case, so they start switched on.
 *
 * Only on an install that already has procedures defined: a brand new
 * database has none and this does nothing. The alternative was leaving every
 * existing procedure billable with no doctor, which is the behaviour being
 * fixed — anybody who wants a nurse-led procedure back can untick it, and
 * that is a visible choice rather than a silent default.
 */
UPDATE services SET requires_doctor = true WHERE category = 'procedure';
