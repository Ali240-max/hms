-- Hospital stores: the consumables that are used, not sold.
--
-- Deliberately separate from the pharmacy's `products` and `batches`. Those
-- model things a customer buys over a counter: they carry a sale price, a tax
-- rate, and they leave the building attached to an invoice. Gauze, cannulas,
-- gloves and IV sets have none of that. They are bought in bulk, issued to a
-- department, and consumed. The question asked of them is "how much did
-- Emergency get through last month", never "what did we sell it for".
--
-- Forcing both into one table would give a products table where half the
-- columns are meaningless for half the rows, and a stock figure that mixes
-- things for sale with things already spoken for.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'store_keeper';

CREATE TABLE IF NOT EXISTS supply_items (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  code           text,
  category       text NOT NULL DEFAULT 'consumable',
  -- What one unit is called when issued: piece, roll, box, pair.
  unit_label     text NOT NULL DEFAULT 'piece',
  -- How many units come in a purchase pack, for receiving by the carton.
  pack_size      integer NOT NULL DEFAULT 1,
  reorder_level  integer NOT NULL DEFAULT 0,
  -- Some consumables expire (sutures, IV fluids), most do not (gloves, linen).
  tracks_expiry  boolean NOT NULL DEFAULT true,
  storage_note   text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supply_items_code_uq  ON supply_items (code) WHERE code IS NOT NULL;
CREATE INDEX        IF NOT EXISTS supply_items_name_idx ON supply_items (name);
CREATE INDEX        IF NOT EXISTS supply_items_cat_idx  ON supply_items (category);

CREATE TABLE IF NOT EXISTS supply_batches (
  id           serial PRIMARY KEY,
  item_id      integer NOT NULL REFERENCES supply_items(id) ON DELETE CASCADE,
  batch_no     text,
  expiry_date  date,
  qty_on_hand  integer NOT NULL DEFAULT 0,
  cost_paisa   bigint NOT NULL DEFAULT 0,
  supplier_id  integer REFERENCES suppliers(id),
  invoice_no   text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  received_by  text
);

CREATE INDEX IF NOT EXISTS supply_batches_item_idx   ON supply_batches (item_id);
CREATE INDEX IF NOT EXISTS supply_batches_expiry_idx ON supply_batches (expiry_date)
  WHERE qty_on_hand > 0;

-- Every movement, append-only. Stock on hand is the sum of the batches; this
-- is the account of how it got that way, and the only thing that can answer a
-- question about last month once the batch itself has been used up.
CREATE TABLE IF NOT EXISTS supply_movements (
  id             serial PRIMARY KEY,
  item_id        integer NOT NULL REFERENCES supply_items(id) ON DELETE CASCADE,
  batch_id       integer REFERENCES supply_batches(id) ON DELETE SET NULL,
  kind           text NOT NULL,
  -- Positive coming in, negative going out. Signed, so a plain sum is the answer.
  qty            integer NOT NULL,
  department_id  integer REFERENCES departments(id),
  issued_to      text,
  reason         text,
  cost_paisa     bigint NOT NULL DEFAULT 0,
  moved_by       text,
  moved_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supply_movements_item_idx ON supply_movements (item_id, moved_at);
CREATE INDEX IF NOT EXISTS supply_movements_dept_idx ON supply_movements (department_id, moved_at);
CREATE INDEX IF NOT EXISTS supply_movements_when_idx ON supply_movements (moved_at);
