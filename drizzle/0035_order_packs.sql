-- Purchase orders are placed in PACKS.
--
-- They were placed in units, on the reasoning that a pharmacist thinks in
-- tablets. That was wrong, and the pharmacy said so plainly: an order goes to
-- a distributor, a distributor ships packs, and the number on the order has to
-- be the number of packs or somebody at the depot does the division — which is
-- the one place nobody wants arithmetic happening.
--
-- The unit figure is kept beside it rather than thrown away. It is what the
-- shelf is counted in, it is what the sales figures are in, and an order read
-- back a year later should still say how many tablets were asked for.
--
-- ONE TRANSACTION PER FILE.

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS order_packs integer;

/*
 * Backfill from what is already there.
 *
 * Any order raised before this change holds units. Dividing by the pack size
 * recovers the packs that were meant, and rounding up rather than down is the
 * safer direction: 95 units of a pack of 10 was somebody asking for ten packs,
 * not nine.
 */
UPDATE purchase_order_items
   SET order_packs = GREATEST(1, CEIL(order_units::numeric
                                      / GREATEST(1, pack_size))::integer)
 WHERE order_packs IS NULL;

ALTER TABLE purchase_order_items
  ALTER COLUMN order_packs SET NOT NULL;

/*
 * Tax on a delivery.
 *
 * Two different taxes, and they are not the same thing.
 *
 * `tax_rate_bp` on the line is the sales tax that medicine carries, applied
 * to that line's value — ten packs at a hundred rupees with ten per cent is
 * a hundred and ten.
 *
 * `extra_tax_bp` on the invoice is whatever the distributor adds at the
 * bottom: a further sales tax, a withholding line, a levy. It applies to the
 * invoice total rather than to any one medicine, so it cannot be folded into
 * the lines without losing which was which.
 *
 * Basis points, like every other rate in this system: 1000 is ten per cent,
 * and a rate like 2.5% survives the round trip.
 */
ALTER TABLE purchase_items
  ADD COLUMN IF NOT EXISTS tax_rate_bp integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_tax_paisa bigint NOT NULL DEFAULT 0;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS extra_tax_bp integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_tax_paisa bigint NOT NULL DEFAULT 0;

/*
 * Discounts at the pharmacy counter.
 *
 * Stored as settings rather than columns, because they describe how the till
 * behaves rather than anything about a sale. Written here so an install that
 * has never opened the settings screen still has a defined answer:
 * discounts on, no ceiling, which is how the till behaves today.
 */
INSERT INTO settings (key, value) VALUES ('pharmacy.discountEnabled', 'true')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('pharmacy.discountMaxPct', '0')
  ON CONFLICT (key) DO NOTHING;

/* -------------------------------------- the money value of an adjustment */

/*
 * What a stock correction was worth, not just how many units moved.
 *
 * "Panadol minus 105" is a quantity. The question that follows it is always
 * how much money walked out of the shop, and answering it needed a cost —
 * which the item rows did not carry.
 *
 * Captured at adjustment time rather than computed in the report, because a
 * purchase price moves. Reading today's price to value a correction made in
 * August would quietly rewrite every historical figure every time a
 * distributor put their rates up.
 */
ALTER TABLE stock_adjustment_items
  ADD COLUMN IF NOT EXISTS unit_cost_paisa bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS value_paisa bigint NOT NULL DEFAULT 0;

/*
 * Existing rows get the product's current purchase price as the best figure
 * available, and it is an estimate rather than a record — there is nothing
 * better to use for an adjustment made before the cost was being kept.
 * Everything from here on carries the real cost at the time.
 */
UPDATE stock_adjustment_items i
   SET unit_cost_paisa = p.purchase_paisa,
       value_paisa     = i.delta_qty * p.purchase_paisa
  FROM products p
 WHERE p.id = i.product_id
   AND i.unit_cost_paisa = 0;
