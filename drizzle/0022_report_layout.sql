-- Not every test reports the same shape.
--
-- The report had four columns — test, result, reference range, units — which
-- suits a chemistry panel and suits nothing else. A test answering POSITIVE
-- or NEGATIVE has no units and no range worth printing, and the two empty
-- columns read as missing information rather than as columns that do not
-- apply.
--
-- And a glucose tolerance test is not a flat list at all: it is three or four
-- timed blocks, each with its own heading, in one table.
--
-- `report_layout`  'standard'    test / result / reference range / units
--                  'qualitative' test / result / normal range
--
-- `section` is the heading a parameter starts, if any. A test with none reads
-- exactly as it does today, which is why it is nullable and why nothing has
-- to be filled in for existing tests to keep working.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS report_layout text NOT NULL DEFAULT 'standard';

ALTER TABLE service_parameters
  ADD COLUMN IF NOT EXISTS section text;
