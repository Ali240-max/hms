-- Stock audits, and the adjustments that follow them.
--
-- An audit is a COUNT SHEET: a list of medicines with what the system thinks
-- is on the shelf, printed with blank columns for somebody to walk the racks
-- and write what is actually there. It changes nothing.
--
-- An adjustment is what happens afterwards, when those numbers are typed back
-- in. That DOES change stock, and it is the one place in the pharmacy where
-- somebody can make inventory appear or disappear by typing. So every line of
-- it is kept forever, with the quantity before, the quantity counted, the
-- difference, who did it and when — and it is always tied to the audit it
-- came from.
--
-- ONE TRANSACTION PER FILE.

/* ---------------------------------------------------------- the count sheet */

CREATE TABLE IF NOT EXISTS stock_audits (
  id            serial PRIMARY KEY,
  /*
   * The number written at the top of the printed sheet.
   *
   * It is what somebody holding a page of pencil marks reads out when they
   * come back to a keyboard, so it has to be short enough to say aloud and
   * impossible to confuse with a bill number. AUD-000042.
   */
  audit_no      text NOT NULL,

  -- product | manufacturer | rack
  -- How the list was chosen. Kept because "every Getz product" and "whatever
  -- these forty happened to be" are different kinds of count, and a year
  -- later nobody remembers which this was.
  scope         text NOT NULL DEFAULT 'product',
  -- The manufacturer or the rack, where the scope names one.
  scope_ref     text,
  title         text,
  note          text,

  -- open | counted | closed
  -- `open` is printed and out on the floor. `counted` has had an adjustment
  -- made against it. `closed` is finished with.
  status        text NOT NULL DEFAULT 'open',

  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     text,
  closed_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_audits_no_uq ON stock_audits (audit_no);
CREATE INDEX IF NOT EXISTS stock_audits_status_idx ON stock_audits (status, created_at);

/* -------------------------------------------------- one line per medicine */

CREATE TABLE IF NOT EXISTS stock_audit_items (
  id            serial PRIMARY KEY,
  audit_id      integer NOT NULL REFERENCES stock_audits(id) ON DELETE CASCADE,
  product_id    integer NOT NULL REFERENCES products(id),

  /*
   * What the system believed WHEN THE SHEET WAS PRINTED.
   *
   * Frozen here rather than read live at adjustment time, and this is the
   * whole point of the feature. Somebody counts the shelf at 9am and types
   * the numbers back at 4pm; in between, the counter has been selling. If the
   * adjustment compared the count against the 4pm figure it would silently
   * undo a day of sales. Comparing against the 9am figure, with the 4pm
   * figure shown beside it, is the only arrangement that cannot lose a sale.
   */
  expected_qty  integer NOT NULL,

  -- The name and manufacturer as printed, so an old sheet still reads
  -- correctly after a product is renamed or a company is merged.
  product_name  text NOT NULL,
  manufacturer  text,
  rack_location text,
  pack_label    text,

  display_order integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS stock_audit_items_audit_idx
  ON stock_audit_items (audit_id, display_order);
CREATE UNIQUE INDEX IF NOT EXISTS stock_audit_items_uq
  ON stock_audit_items (audit_id, product_id);

/* ------------------------------------------------------- the adjustment */

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id             serial PRIMARY KEY,
  adjustment_no  text NOT NULL,
  /*
   * Always against an audit. Never free-standing.
   *
   * An adjustment with no count behind it is somebody typing a number into
   * the stock of a controlled medicine with nothing to point at. Requiring
   * the audit means every change traces back to a printed sheet somebody
   * walked the floor with.
   */
  audit_id       integer NOT NULL REFERENCES stock_audits(id),
  note           text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_adjustments_no_uq
  ON stock_adjustments (adjustment_no);
CREATE INDEX IF NOT EXISTS stock_adjustments_audit_idx ON stock_adjustments (audit_id);
CREATE INDEX IF NOT EXISTS stock_adjustments_when_idx ON stock_adjustments (created_at);

CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id              serial PRIMARY KEY,
  adjustment_id   integer NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  product_id      integer NOT NULL REFERENCES products(id),

  /*
   * Three numbers, all kept, because the difference between them is the
   * entire story and none of the three can be worked out from the others
   * afterwards.
   *
   *   expected_qty  what the system said when the sheet printed
   *   before_qty    what the system said at the moment of adjustment
   *   counted_qty   what was actually on the shelf
   */
  expected_qty    integer NOT NULL,
  before_qty      integer NOT NULL,
  counted_qty     integer NOT NULL,
  -- counted minus before. Stored rather than computed so a report reads the
  -- same figure the adjustment acted on, whatever happens later.
  delta_qty       integer NOT NULL,

  product_name    text NOT NULL,
  manufacturer    text,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_adjustment_items_adj_idx
  ON stock_adjustment_items (adjustment_id);
/* For "every time panadol was adjusted", which is a question that gets asked. */
CREATE INDEX IF NOT EXISTS stock_adjustment_items_product_idx
  ON stock_adjustment_items (product_id, created_at);

/*
 * The ledger finally gets written to.
 *
 * It was created in the first migration and nothing has ever inserted into
 * it. An adjustment is exactly what it was for: a quantity change with a
 * reason, an actor and a reference back to the thing that caused it.
 */
CREATE INDEX IF NOT EXISTS stock_ledger_reason_idx ON stock_ledger (reason, occurred_at);
