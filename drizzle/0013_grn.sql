-- A goods-received number on every delivery.
--
-- Until now a delivery was identified by the supplier's own invoice number,
-- which is theirs and not ours: two suppliers use the same number in the same
-- week, one sends no number at all, and a store keeper asking "which delivery"
-- has nothing to point at.
--
-- The GRN is the hospital's own reference for the act of receiving. It follows
-- the same shape as every other document in the system:
--
--     GRN-260919-G00007
--      |     |     | |
--      |     |     | +-- the day's sequence, reset each morning
--      |     |     +---- G for goods received
--      |     +---------- the date, YYMMDD
--      +---------------- the document
--
-- Existing deliveries are given one from their own invoice date, so the
-- reports work over history rather than only over what arrives next.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS grn_no text;

-- Backfill: numbered by the day they were received, in the order they were
-- entered, so the sequence reads the way it would have been issued.
WITH numbered AS (
  SELECT id,
         'GRN-' || to_char(invoice_date, 'YYMMDD') || '-G' ||
           lpad(row_number() OVER (PARTITION BY invoice_date ORDER BY id)::text, 5, '0')
           AS generated
  FROM purchases
  WHERE grn_no IS NULL
)
UPDATE purchases p SET grn_no = n.generated
FROM numbered n WHERE n.id = p.id;

CREATE UNIQUE INDEX IF NOT EXISTS purchases_grn_no_uq ON purchases (grn_no)
  WHERE grn_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchases_grn_idx ON purchases (grn_no);
