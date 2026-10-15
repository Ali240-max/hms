-- Stock that leaves the shelf without being sold.
--
-- Two reasons for it, and they are the same event mechanically: a carton goes
-- on the floor, or a box goes past its date. Both take units off a batch,
-- both cost the shop money, and both have to be answerable months later when
-- somebody asks why the shelf and the ledger disagree.
--
-- ONE TABLE FOR BOTH KINDS, with `kind` telling them apart.
--
-- Two tables would have meant two of everything — two services, two sets of
-- reports, two numbering counters — to hold rows that differ in one word. It
-- also makes the question "what did we lose this month" one query instead of
-- a union that somebody will forget to update when a third reason appears.
--
-- The screens stay separate because the people and the moment are different:
-- breakage is noticed at the counter and logged straight away, expiry is a
-- monthly sweep of the racks with a different list in front of you.
--
-- ONE TRANSACTION PER FILE.

CREATE TABLE IF NOT EXISTS write_offs (
  id            serial PRIMARY KEY,

  /*
   * The tracking number, date-prefixed like every other document here.
   *
   *   DMG-261010-01   damage
   *   EXP-261010-01   expiry
   *
   * Separate counters per kind per day, so the damage slips read 01, 02, 03
   * through the day and the expiry sweep does not interleave with them. A
   * shared counter would produce DMG-01 and EXP-02 on the same morning, and
   * somebody filing paper by number would find a gap and go looking for the
   * slip that was never missing.
   */
  write_off_no  text NOT NULL UNIQUE,

  kind          text NOT NULL CHECK (kind IN ('damage', 'expiry')),

  /*
   * The totals, counted from the lines and frozen here.
   *
   * Could be summed from write_off_items on every read. Stored because the
   * list screen shows twenty of these at once and the value is the column
   * people sort by — and because a total that recomputes is a total that can
   * change after the fact, which defeats the point of keeping the record.
   */
  lines         integer NOT NULL DEFAULT 0,
  units         integer NOT NULL DEFAULT 0,
  value_paisa   bigint  NOT NULL DEFAULT 0,

  note          text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS write_offs_kind_date
  ON write_offs (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS write_off_items (
  id            serial PRIMARY KEY,
  write_off_id  integer NOT NULL REFERENCES write_offs(id) ON DELETE CASCADE,
  product_id    integer NOT NULL REFERENCES products(id),

  /*
   * ONE ROW PER BATCH, not per medicine.
   *
   * Seventy units of a medicine held sixty in one batch and twenty-five in
   * another comes off as sixty and ten. Recording it as one line of seventy
   * would lose which batch each unit came from — and with it the expiry date
   * and the cost, which is the whole reason anybody keeps this record.
   */
  batch_id      integer REFERENCES batches(id),

  qty           integer NOT NULL CHECK (qty > 0),

  /*
   * What that stock cost, taken off the batch at the moment it was written
   * off, never read back from the product afterwards.
   *
   * Two batches of the same medicine bought six months apart cost different
   * money. Valuing August's breakage at today's purchase rate would quietly
   * rewrite every past figure each time a distributor raised a price, and the
   * monthly loss report would move on its own.
   */
  unit_cost_paisa bigint NOT NULL DEFAULT 0,
  value_paisa     bigint NOT NULL DEFAULT 0,

  /*
   * Copied, not joined.
   *
   * A medicine gets renamed, a batch gets deleted in some future cleanup, and
   * a two-year-old slip still has to print the words that were on it. The
   * join is still there for anything live; these are for the record.
   */
  product_name  text NOT NULL,
  batch_no      text,
  expiry_date   date,

  reason        text
);

CREATE INDEX IF NOT EXISTS write_off_items_parent
  ON write_off_items (write_off_id);
CREATE INDEX IF NOT EXISTS write_off_items_product
  ON write_off_items (product_id);

/*
 * The ledger reasons were defined and never used.
 *
 * `damage` and `expiry_writeoff` have been in the movement_reason enum since
 * the very first migration, written in anticipation of exactly this screen.
 * Nothing has ever inserted a row under either. This is the migration that
 * makes them real, and they are used as they stand rather than a third value
 * being added — a report filtering on `damage` should find all the damage,
 * not the damage that happened to be logged after somebody renamed the enum.
 *
 * No schema change is needed here. This comment is the note that would
 * otherwise have to be rediscovered by reading the enum and wondering.
 */
