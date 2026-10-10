-- Male and female ranges as numbers, not as prose.
--
-- They were one text box each, holding "13.0 - 17.5". That made three
-- competing places to write a normal value on the same row — low and high,
-- the free text box, and the two sex boxes — and nothing said which one won.
-- It also could not be compared without parsing English back into numbers.
--
-- Four numeric columns instead, and the free-text box drops off the numbers
-- layout entirely. A row now says its normal value exactly once:
--
--   numbers              low and high
--   numbers with M/F     low and high for each sex
--   written range        an operator and a number
--   positive or negative free text, which is all it ever was
--
-- The old text is carried across where it reads as a simple range, so nothing
-- already typed is lost.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE service_parameters
  ADD COLUMN IF NOT EXISTS male_low    numeric(14, 4),
  ADD COLUMN IF NOT EXISTS male_high   numeric(14, 4),
  ADD COLUMN IF NOT EXISTS female_low  numeric(14, 4),
  ADD COLUMN IF NOT EXISTS female_high numeric(14, 4);

UPDATE service_parameters
SET male_low    = NULLIF(substring(ref_male   from '(-?[0-9]+(?:\.[0-9]+)?)\s*[-–]'), '')::numeric,
    male_high   = NULLIF(substring(ref_male   from '[-–]\s*(-?[0-9]+(?:\.[0-9]+)?)'), '')::numeric,
    female_low  = NULLIF(substring(ref_female from '(-?[0-9]+(?:\.[0-9]+)?)\s*[-–]'), '')::numeric,
    female_high = NULLIF(substring(ref_female from '[-–]\s*(-?[0-9]+(?:\.[0-9]+)?)'), '')::numeric
WHERE has_sex_ranges;
