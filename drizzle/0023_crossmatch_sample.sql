-- When the sample was taken for a cross match.
--
-- Every other report from this laboratory prints Sample Taken and Reported
-- side by side, because a doctor reading a result wants to know how old the
-- sample is. The cross match printed only the reported time, which left that
-- unanswerable on the one report where the age of the sample decides whether
-- the bag can still be issued.
--
-- Defaults to the moment the report was written, which is what it was before
-- in effect; a laboratory that draws and cross matches at different times can
-- now say so.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE cross_matches
  ADD COLUMN IF NOT EXISTS sample_taken_at timestamptz;

UPDATE cross_matches SET sample_taken_at = created_at WHERE sample_taken_at IS NULL;
