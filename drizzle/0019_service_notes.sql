-- The note printed under a test belongs to the test.
--
-- It was a single hospital-wide heading and a single standard note, which is
-- wrong: a Vitamin D report ends with a line about analysers and seasonal
-- variation, a CBC ends with a line about slide review, and a culture ends
-- with something else entirely. One setting for all of them meant it was
-- right for none.
--
-- The heading is per test too, because laboratories word it differently:
-- "Note", "Please note", "Comments", "Interpretation".
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE services ADD COLUMN IF NOT EXISTS note_heading text;
ALTER TABLE services ADD COLUMN IF NOT EXISTS note_text    text;
