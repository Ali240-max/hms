-- Normal values that differ by sex, and a third report layout.
--
-- Haemoglobin is 13.0 to 17.5 for a man and 11.5 to 15.0 for a woman. One
-- column could only ever hold one of those, so every CBC printed a range that
-- was wrong for half the patients who read it.
--
-- `ref_male` and `ref_female` are free text for the same reason `ref_text`
-- is: a laboratory writes "13.0 - 17.5", "< 0.50" and "Upto 15 Years: < 345",
-- and a pair of number columns loses all three.
--
-- `has_sex_ranges` is stored rather than inferred from the two columns being
-- filled, so a technologist can switch the row back to one range without
-- losing what was typed in the other two.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE service_parameters
  ADD COLUMN IF NOT EXISTS ref_male       text,
  ADD COLUMN IF NOT EXISTS ref_female     text,
  ADD COLUMN IF NOT EXISTS has_sex_ranges boolean NOT NULL DEFAULT false;
