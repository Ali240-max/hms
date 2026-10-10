-- Purchase orders, and the two things a supplier needs before you can raise one.
--
-- Ordering was the gap in the middle of the pharmacy. Stock arriving was
-- recorded (purchases), stock leaving was recorded (sales), and the decision
-- in between — what to ask for, from whom, in what quantity — happened on a
-- scrap of paper at the counter and left no trace.
--
-- Three parts here:
--
--   1. which companies each supplier actually carries, so choosing a supplier
--      narrows the list of medicines to the ones they can bring
--   2. when that supplier takes orders, which is a fixed weekly slot for
--      nearly all of them (Saturday 7pm) and the thing people forget
--   3. the order itself, in UNITS rather than packs, with the sales figure the
--      quantity was suggested from kept beside it
--
-- ONE TRANSACTION PER FILE.

/* ------------------------------------------- what a supplier actually carries */

/*
 * A supplier is a distributor; a company is who made the medicine. One
 * distributor carries several companies and one company is carried by
 * several distributors, so this is a join table rather than a column on
 * either side.
 *
 * Nothing breaks if a supplier has no rows here. An order screen with no
 * companies recorded shows everything rather than nothing, because an empty
 * list is far more likely to mean "nobody has filled this in yet" than
 * "this supplier sells nothing".
 */
CREATE TABLE IF NOT EXISTS supplier_companies (
  supplier_id     integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  manufacturer_id integer NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, manufacturer_id)
);

CREATE INDEX IF NOT EXISTS supplier_companies_mfr_idx
  ON supplier_companies (manufacturer_id);

/* ---------------------------------------------------- when they take orders */

CREATE TABLE IF NOT EXISTS supplier_booking_slots (
  id          serial PRIMARY KEY,
  supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  /*
   * 0 = Sunday through 6 = Saturday, matching JavaScript's getDay() so the
   * screen needs no translation table of its own.
   */
  weekday     integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  /*
   * Local wall-clock time, no date and no zone. "Saturday 7pm" is a standing
   * arrangement with a human being, not an instant — it does not shift when
   * the clocks do, and storing it as timestamptz would invent a date it
   * never had.
   */
  at_time     time NOT NULL,
  note        text
);

CREATE INDEX IF NOT EXISTS supplier_booking_slots_supplier_idx
  ON supplier_booking_slots (supplier_id, weekday, at_time);
/* The same day and time twice for one supplier is a mis-click, not a fact. */
CREATE UNIQUE INDEX IF NOT EXISTS supplier_booking_slots_uq
  ON supplier_booking_slots (supplier_id, weekday, at_time);

/* ----------------------------------------------------------- the order */

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            serial PRIMARY KEY,
  /* PO-261009-03: the date it was raised, then the count for that day. */
  order_no      text NOT NULL,
  supplier_id   integer NOT NULL REFERENCES suppliers(id),

  -- open | received | cancelled
  -- `open` is waiting on the supplier. `received` has had a delivery booked
  -- against it. `cancelled` was never sent, or was abandoned.
  status        text NOT NULL DEFAULT 'open',

  /*
   * How many days of sales the suggested quantities came from.
   *
   * Kept because the same order looks reckless or cautious depending on it.
   * Three hundred units is a sensible fortnight and an alarming afternoon,
   * and a month later nobody remembers which window was on screen.
   */
  window_days   integer NOT NULL DEFAULT 7,
  note          text,

  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     text,
  closed_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_no_uq
  ON purchase_orders (order_no);
CREATE INDEX IF NOT EXISTS purchase_orders_status_idx
  ON purchase_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx
  ON purchase_orders (supplier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id            serial PRIMARY KEY,
  order_id      integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id    integer NOT NULL REFERENCES products(id),

  /*
   * UNITS, not packs. This is the one place in the system that works in
   * units deliberately.
   *
   * A pharmacist orders "two hundred Panadol", meaning tablets. The pack is
   * the distributor's unit, not the shop's, and asking somebody to divide by
   * ten in their head at the counter is how you order ten times too many.
   * Receiving converts back to packs, where the pack genuinely is the thing
   * being counted off a delivery note.
   */
  order_units   integer NOT NULL,

  /*
   * The two figures the suggestion was built from, frozen at the moment the
   * order was raised.
   *
   * Without these, an order read back later is a number with no argument
   * behind it. With them you can see that 240 was suggested because 240 sold,
   * and that somebody then typed 400 anyway.
   */
  sold_units    integer NOT NULL DEFAULT 0,
  stock_units   integer NOT NULL DEFAULT 0,

  -- As printed, so an old order still reads correctly after a rename.
  product_name  text NOT NULL,
  manufacturer  text,
  pack_size     integer NOT NULL DEFAULT 1,
  pack_label    text,

  display_order integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS purchase_order_items_order_idx
  ON purchase_order_items (order_id, display_order);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_items_uq
  ON purchase_order_items (order_id, product_id);

/* ------------------------------------------- tying a delivery to its order */

/*
 * Nullable, and it stays nullable.
 *
 * Deliveries arrive without an order behind them — a rep turns up, something
 * urgent is fetched by hand — and those are ordinary purchases, not errors.
 * Requiring an order here would mean inventing a fake one every time.
 */
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS purchase_order_id integer REFERENCES purchase_orders(id);

CREATE INDEX IF NOT EXISTS purchases_order_idx ON purchases (purchase_order_id);

/* --------------------------------------------------------- opening stock */

/*
 * The ledger needs a word for stock that was never bought from anybody.
 *
 * Opening a shop with existing shelves means typing in what is already
 * there, and until now the only reasons available were `purchase` (a lie,
 * there is no invoice) and `stock_count` (also a lie, nothing was counted
 * against a system figure). Both would have made the first day of trading
 * unreadable in the stock ledger.
 */
ALTER TYPE movement_reason ADD VALUE IF NOT EXISTS 'opening';
