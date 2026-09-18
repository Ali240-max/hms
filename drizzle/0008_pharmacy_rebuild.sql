-- The pharmacy, rebuilt around how a real Pakistani pharmacy is actually run.
--
-- Three changes of substance, each taken from twenty years of a working
-- system rather than invented here.
--
-- 1. PRICE LIVES ON THE PRODUCT, NOT THE BATCH.
--    The old build set a sale price while receiving each delivery, which
--    meant the same medicine could carry three prices on three shelves and
--    the counter had to be told which. Every pharmacy here prices the product
--    once — purchase rate, trade rate, retail rate — and a delivery only
--    brings quantity and cost. Batches still exist for expiry and traceability;
--    they just stop being a pricing decision.
--
-- 2. A PRODUCT HAS A FORMULA.
--    A pharmacist asked for "something with cetirizine" needs to find every
--    brand of it. Salt is the axis they actually search on.
--
-- 3. MONEY IS DOUBLE ENTRY.
--    Customer and supplier ledgers with a debit and a credit for every
--    movement, so a balance is derived from entries rather than kept as a
--    running number somebody can edit.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'pharmacy_admin';

/* ------------------------------------------------------------- masters */

-- The generic. 1,214 of these came out of the old system's formula list.
CREATE TABLE IF NOT EXISTS salts (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS salts_name_uq ON salts (lower(name));

-- The manufacturer. Separate from the supplier: GSK makes it, a distributor
-- in Gujrat sells it to you, and the two are rarely the same company.
CREATE TABLE IF NOT EXISTS manufacturers (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  short_name text,
  phone      text,
  address    text,
  is_active  boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS manufacturers_name_uq ON manufacturers (lower(name));

-- Shelf grouping: tablets, syrups, injections, surgical, cosmetics.
CREATE TABLE IF NOT EXISTS product_groups (
  id        serial PRIMARY KEY,
  name      text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS product_groups_name_uq ON product_groups (lower(name));

/*
 * Who is being sold to.
 *
 * In a hospital pharmacy most of these are internal — Emergency, General
 * Ward, Eye OPD — and the rest are walk-ins and a handful of credit
 * customers. `kind` decides whether a sale can be put on account.
 */
CREATE TABLE IF NOT EXISTS parties (
  id             serial PRIMARY KEY,
  code           text,
  name           text NOT NULL,
  kind           text NOT NULL DEFAULT 'counter',
  phone          text,
  address        text,
  -- Refused past this. 0 means no credit at all, null means no limit.
  credit_limit_paisa bigint DEFAULT 0,
  opening_paisa  bigint NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parties_name_idx ON parties (lower(name));
CREATE INDEX IF NOT EXISTS parties_kind_idx ON parties (kind);

/* ------------------------------------------------- product, re-specified */

ALTER TABLE products ADD COLUMN IF NOT EXISTS salt_id integer REFERENCES salts(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_id integer REFERENCES manufacturers(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS group_id integer REFERENCES product_groups(id);

-- Pricing, set once on the product. Per single unit, in paisa.
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_paisa bigint NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS trade_paisa    bigint NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS retail_paisa   bigint NOT NULL DEFAULT 0;
-- How the pack is written on the box: 1X10, 30'S, 120ML.
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_label text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS max_level integer NOT NULL DEFAULT 0;

-- Every price change, with who and when. The old system kept 6,315 of these
-- going back to 2012 and it is the first thing anyone checks in an argument
-- about margin.
CREATE TABLE IF NOT EXISTS price_history (
  id                serial PRIMARY KEY,
  product_id        integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_purchase_paisa bigint, new_purchase_paisa bigint,
  old_trade_paisa    bigint, new_trade_paisa    bigint,
  old_retail_paisa   bigint, new_retail_paisa   bigint,
  changed_by        text,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  reason            text
);
CREATE INDEX IF NOT EXISTS price_history_product_idx ON price_history (product_id, changed_at);

/* --------------------------------------------------------- selling */

ALTER TABLE sales ADD COLUMN IF NOT EXISTS party_id integer REFERENCES parties(id);
-- 'counter' paid now, 'credit' on account, 'estimate' not a sale yet.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_kind text NOT NULL DEFAULT 'counter';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_by text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS printed_count integer NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS salesman text;

CREATE INDEX IF NOT EXISTS sales_party_idx ON sales (party_id, sold_at);
CREATE INDEX IF NOT EXISTS sales_kind_idx  ON sales (sale_kind, sold_at);

-- Goods coming back over the counter.
CREATE TABLE IF NOT EXISTS sale_returns (
  id              serial PRIMARY KEY,
  return_no       text NOT NULL,
  sale_id         integer REFERENCES sales(id),
  party_id        integer REFERENCES parties(id),
  customer_name   text,
  total_paisa     bigint NOT NULL DEFAULT 0,
  reason          text,
  returned_by     text,
  returned_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sale_returns_no_uq ON sale_returns (return_no);
CREATE INDEX IF NOT EXISTS sale_returns_when_idx ON sale_returns (returned_at);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id             serial PRIMARY KEY,
  return_id      integer NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  product_id     integer NOT NULL REFERENCES products(id),
  batch_id       integer REFERENCES batches(id),
  product_name   text NOT NULL,
  qty            integer NOT NULL,
  unit_price_paisa bigint NOT NULL DEFAULT 0,
  line_total_paisa bigint NOT NULL DEFAULT 0,
  -- Back on the shelf, or written off as unsellable.
  restock        boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS sale_return_items_ret_idx ON sale_return_items (return_id);

/* ---------------------------------------------------------- buying */

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS discount_paisa bigint NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS tax_paisa bigint NOT NULL DEFAULT 0;
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS discount_bp integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS purchase_returns (
  id            serial PRIMARY KEY,
  return_no     text NOT NULL,
  supplier_id   integer NOT NULL REFERENCES suppliers(id),
  purchase_id   integer REFERENCES purchases(id),
  total_paisa   bigint NOT NULL DEFAULT 0,
  reason        text,
  returned_by   text,
  returned_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_returns_no_uq ON purchase_returns (return_no);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id            serial PRIMARY KEY,
  return_id     integer NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id    integer NOT NULL REFERENCES products(id),
  batch_id      integer REFERENCES batches(id),
  product_name  text NOT NULL,
  qty           integer NOT NULL,
  cost_paisa    bigint NOT NULL DEFAULT 0,
  line_total_paisa bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS purchase_return_items_ret_idx ON purchase_return_items (return_id);

/* ------------------------------------------------------ double entry */

/*
 * One row per side of every movement of money.
 *
 * A balance is the sum of the entries, never a number kept on the master
 * record. The old system carried twelve monthly buckets on every customer
 * and supplier row, and those buckets drift the moment anything is corrected.
 *
 * `party_kind` plus `party_ref` rather than two nullable columns: one index
 * serves both ledgers and a statement is one query.
 */
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            serial PRIMARY KEY,
  party_kind    text NOT NULL,          -- 'customer' | 'supplier'
  party_ref     integer NOT NULL,
  entry_date    date NOT NULL DEFAULT CURRENT_DATE,
  description   text NOT NULL,
  debit_paisa   bigint NOT NULL DEFAULT 0,
  credit_paisa  bigint NOT NULL DEFAULT 0,
  -- What caused it, so a statement line can be opened.
  source        text,
  source_id     integer,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_party_idx ON ledger_entries (party_kind, party_ref, entry_date);
CREATE INDEX IF NOT EXISTS ledger_source_idx ON ledger_entries (source, source_id);
CREATE INDEX IF NOT EXISTS ledger_date_idx ON ledger_entries (entry_date);

-- Cash and bank movements against a party.
CREATE TABLE IF NOT EXISTS payments (
  id            serial PRIMARY KEY,
  voucher_no    text NOT NULL,
  -- 'receipt' money in from a customer, 'payment' money out to a supplier.
  kind          text NOT NULL,
  party_kind    text NOT NULL,
  party_ref     integer NOT NULL,
  amount_paisa  bigint NOT NULL,
  method        text NOT NULL DEFAULT 'cash',
  reference     text,
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_voucher_uq ON payments (voucher_no);
CREATE INDEX IF NOT EXISTS payments_party_idx ON payments (party_kind, party_ref, created_at);

/* ------------------------------------------------------- permissions */

/*
 * Per-user rather than per-role.
 *
 * The old system carried 47 individual flags per user and that granularity is
 * the reason it survived twenty years of staff changes: the owner can let a
 * new boy sell without letting him see margins or change a price. Roles stay
 * as the default; this overrides them one checkbox at a time.
 */
CREATE TABLE IF NOT EXISTS staff_permissions (
  id         serial PRIMARY KEY,
  staff_id   integer NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  permission text NOT NULL,
  allowed    boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_permissions_uq ON staff_permissions (staff_id, permission);
