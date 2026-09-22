import { sql } from 'drizzle-orm'
import { db, nextCounter } from '../db/client'
import { documentNo } from './numbering'

/**
 * The pharmacy's own masters and money.
 *
 * Two rules run through all of it.
 *
 * Price belongs to the product. A delivery brings quantity and cost; it does
 * not decide what the medicine sells for. Every pharmacy here prices once and
 * reprices deliberately, and the change is recorded — the old system kept
 * 6,315 such records going back to 2012 and it is the first thing anyone
 * reaches for in an argument about margin.
 *
 * A balance is the sum of ledger entries, never a running total on a master
 * row. The system this replaces carried twelve monthly buckets on every
 * customer and supplier; those drift the moment anything is corrected, and
 * then nobody trusts either number.
 */

export class PharmaError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'IN_USE' | 'OVER_LIMIT' | 'BAD_INPUT' | 'ALREADY_DONE') { super(msg) }
}

/* ---------------------------------------------------------------- salts */

/**
 * Closest first, not alphabetical.
 *
 * Someone typing "cet" wants Cetirizine, not every formula with "cet" buried
 * in the middle sorted from A. So a name that starts with what was typed comes
 * first, then one where a later word does, then anything containing it.
 * Empty search returns the most used, which is what a blank dropdown should
 * offer.
 */
export async function listSalts(q = '') {
  const term = q.trim()
  const r = await db.execute<any>(sql`
    SELECT s.*, (SELECT COUNT(*)::int FROM products p WHERE p.salt_id = s.id) AS product_count
    FROM salts s
    WHERE s.is_active AND (${term} = '' OR s.name ILIKE ${'%' + term + '%'})
    ORDER BY
      CASE
        WHEN ${term} = '' THEN 0
        WHEN s.name ILIKE ${term + '%'} THEN 0
        WHEN s.name ILIKE ${'% ' + term + '%'} THEN 1
        ELSE 2
      END,
      (SELECT COUNT(*) FROM products p WHERE p.salt_id = s.id) DESC,
      length(s.name), s.name
    LIMIT ${term === '' ? 40 : 60}`)
  return r.rows
}

export async function createSalt(name: string) {
  const r = await db.execute<any>(sql`
    INSERT INTO salts (name) VALUES (${name.trim()})
    ON CONFLICT (lower(name)) DO UPDATE SET is_active = true
    RETURNING *`)
  return (r.rows as any[])[0]
}

/** Every brand of one generic. The question a pharmacist actually asks. */
export async function brandsOfSalt(saltId: number) {
  const r = await db.execute<any>(sql`
    SELECT p.id, p.name, p.strength, p.retail_paisa, m.name AS manufacturer,
           COALESCE((SELECT SUM(b.qty_on_hand)::int FROM batches b
                     WHERE b.product_id = p.id AND b.qty_on_hand > 0
                       AND b.expiry_date > CURRENT_DATE), 0) AS on_hand
    FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE p.salt_id = ${saltId} AND p.is_active
    ORDER BY p.name`)
  return r.rows
}

/* ------------------------------------------------- manufacturers, groups */

/** Same ranking as formulas: what you are typing the start of, first. */
export async function listManufacturers(q = '') {
  const term = q.trim()
  const r = await db.execute<any>(sql`
    SELECT m.*, (SELECT COUNT(*)::int FROM products p WHERE p.manufacturer_id = m.id) AS product_count
    FROM manufacturers m
    WHERE m.is_active AND (${term} = '' OR m.name ILIKE ${'%' + term + '%'}
                           OR m.short_name ILIKE ${'%' + term + '%'})
    ORDER BY
      CASE
        WHEN ${term} = '' THEN 0
        WHEN m.name ILIKE ${term + '%'} OR m.short_name ILIKE ${term + '%'} THEN 0
        WHEN m.name ILIKE ${'% ' + term + '%'} THEN 1
        ELSE 2
      END,
      (SELECT COUNT(*) FROM products p WHERE p.manufacturer_id = m.id) DESC,
      m.name
    LIMIT ${term === '' ? 60 : 80}`)
  return r.rows
}

export async function createManufacturer(b: any) {
  const r = await db.execute<any>(sql`
    INSERT INTO manufacturers (name, short_name, phone, address)
    VALUES (${b.name.trim()}, ${b.shortName ?? null}, ${b.phone ?? null}, ${b.address ?? null})
    ON CONFLICT (lower(name)) DO UPDATE SET is_active = true
    RETURNING *`)
  return (r.rows as any[])[0]
}

export async function listGroups() {
  const r = await db.execute<any>(sql`
    SELECT g.*, (SELECT COUNT(*)::int FROM products p WHERE p.group_id = g.id) AS product_count
    FROM product_groups g WHERE g.is_active ORDER BY g.name`)
  return r.rows
}

export async function createGroup(name: string) {
  const r = await db.execute<any>(sql`
    INSERT INTO product_groups (name) VALUES (${name.trim()})
    ON CONFLICT (lower(name)) DO UPDATE SET is_active = true RETURNING *`)
  return (r.rows as any[])[0]
}

/* -------------------------------------------------------------- parties */

export async function listParties(opts: { q?: string; kind?: string } = {}) {
  const { q = '', kind = 'all' } = opts
  const like = `%${q}%`
  const r = await db.execute<any>(sql`
    SELECT p.*,
           COALESCE(l.debit, 0)::bigint AS debit_paisa,
           COALESCE(l.credit, 0)::bigint AS credit_paisa,
           (p.opening_paisa + COALESCE(l.debit,0) - COALESCE(l.credit,0))::bigint AS balance_paisa,
           l.last_at
    FROM parties p
    LEFT JOIN LATERAL (
      SELECT SUM(debit_paisa) AS debit, SUM(credit_paisa) AS credit, MAX(entry_date) AS last_at
      FROM ledger_entries e WHERE e.party_kind = 'customer' AND e.party_ref = p.id
    ) l ON true
    WHERE p.is_active
      AND (${kind} = 'all' OR p.kind = ${kind})
      AND (${q} = '' OR p.name ILIKE ${like} OR p.code ILIKE ${like} OR p.phone ILIKE ${like})
    ORDER BY p.name LIMIT 300`)
  return r.rows
}

export async function createParty(b: any) {
  const r = await db.execute<any>(sql`
    INSERT INTO parties (code, name, kind, phone, address, credit_limit_paisa, opening_paisa)
    VALUES (${b.code ?? null}, ${b.name.trim()}, ${b.kind ?? 'counter'},
            ${b.phone ?? null}, ${b.address ?? null},
            ${b.creditLimitPaisa ?? 0}, ${b.openingPaisa ?? 0})
    RETURNING *`)
  const party = (r.rows as any[])[0]
  if (Number(b.openingPaisa ?? 0) !== 0) {
    await postLedger({
      partyKind: 'customer', partyRef: party.id,
      description: 'Opening balance',
      debitPaisa: Math.max(0, Number(b.openingPaisa)),
      creditPaisa: Math.max(0, -Number(b.openingPaisa)),
      source: 'opening', sourceId: party.id, by: b.by ?? 'system'
    })
  }
  return party
}

/* --------------------------------------------------------- the ledger */

export async function postLedger(e: {
  partyKind: 'customer' | 'supplier'
  partyRef: number
  description: string
  debitPaisa?: number
  creditPaisa?: number
  source?: string
  sourceId?: number
  entryDate?: string
  by?: string
  tx?: any
}) {
  const runner = e.tx ?? db
  const r = await runner.execute(sql`
    INSERT INTO ledger_entries
      (party_kind, party_ref, entry_date, description, debit_paisa, credit_paisa,
       source, source_id, created_by)
    VALUES (${e.partyKind}, ${e.partyRef},
            ${e.entryDate ? sql`${e.entryDate}::date` : sql`CURRENT_DATE`},
            ${e.description}, ${e.debitPaisa ?? 0}, ${e.creditPaisa ?? 0},
            ${e.source ?? null}, ${e.sourceId ?? null}, ${e.by ?? null})
    RETURNING *`)
  return ((r as any).rows as any[])[0]
}

/**
 * A statement, with a running balance.
 *
 * The running total is computed here rather than stored, so inserting a
 * forgotten receipt last week corrects every line after it automatically.
 */
export async function statement(partyKind: string, partyRef: number,
                                from?: string, to?: string) {
  const opening = (await db.execute<any>(sql`
    SELECT CASE WHEN ${partyKind} = 'customer'
             THEN COALESCE((SELECT opening_paisa FROM parties WHERE id = ${partyRef}), 0)
             ELSE 0 END
           + COALESCE((SELECT SUM(debit_paisa - credit_paisa) FROM ledger_entries
                       WHERE party_kind = ${partyKind} AND party_ref = ${partyRef}
                         AND (${from ?? null}::date IS NULL OR entry_date < ${from ?? null}::date)), 0)
           AS opening_paisa`)).rows[0]

  const rows = (await db.execute<any>(sql`
    SELECT * FROM ledger_entries
    WHERE party_kind = ${partyKind} AND party_ref = ${partyRef}
      AND (${from ?? null}::date IS NULL OR entry_date >= ${from ?? null}::date)
      AND (${to ?? null}::date IS NULL OR entry_date <= ${to ?? null}::date)
    ORDER BY entry_date, id`)).rows as any[]

  let running = Number(opening.opening_paisa)
  const lines = rows.map((r) => {
    running += Number(r.debit_paisa) - Number(r.credit_paisa)
    return { ...r, balance_paisa: running }
  })

  const party = (await db.execute<any>(sql`
    SELECT ${partyKind} = 'customer' AS is_customer,
           CASE WHEN ${partyKind} = 'customer'
             THEN (SELECT name FROM parties WHERE id = ${partyRef})
             ELSE (SELECT name FROM suppliers WHERE id = ${partyRef}) END AS name`)).rows[0]

  return {
    party, openingPaisa: Number(opening.opening_paisa),
    lines, closingPaisa: running,
    totals: {
      debit: rows.reduce((n, r) => n + Number(r.debit_paisa), 0),
      credit: rows.reduce((n, r) => n + Number(r.credit_paisa), 0)
    }
  }
}

/** Everyone who owes, or is owed. The list a pharmacy chases on a Friday. */
export async function outstanding(partyKind: 'customer' | 'supplier') {
  const r = await db.execute<any>(sql`
    SELECT e.party_ref,
           CASE WHEN ${partyKind} = 'customer'
             THEN (SELECT name FROM parties WHERE id = e.party_ref)
             ELSE (SELECT name FROM suppliers WHERE id = e.party_ref) END AS name,
           SUM(e.debit_paisa)::bigint AS debit_paisa,
           SUM(e.credit_paisa)::bigint AS credit_paisa,
           SUM(e.debit_paisa - e.credit_paisa)::bigint AS balance_paisa,
           MAX(e.entry_date) AS last_movement
    FROM ledger_entries e
    WHERE e.party_kind = ${partyKind}
    GROUP BY e.party_ref
    HAVING SUM(e.debit_paisa - e.credit_paisa) <> 0
    ORDER BY ABS(SUM(e.debit_paisa - e.credit_paisa)) DESC
    LIMIT 200`)
  return r.rows
}

/* -------------------------------------------------------------- payments */

export async function recordPayment(input: {
  kind: 'receipt' | 'payment'
  partyKind: 'customer' | 'supplier'
  partyRef: number
  amountPaisa: number
  method?: string
  reference?: string | null
  note?: string | null
  by: string
}) {
  if (input.amountPaisa <= 0) throw new PharmaError('Amount must be above zero', 'BAD_INPUT')
  return db.transaction(async (tx) => {
    // RV money in, PV money out. Both dated, both reset daily.
    const voucherNo = await documentNo(tx, {
      prefix: input.kind === 'receipt' ? 'RV' : 'PV',
      letter: input.kind === 'receipt' ? 'R' : 'P'
    })

    const v = (await tx.execute<any>(sql`
      INSERT INTO payments (voucher_no, kind, party_kind, party_ref, amount_paisa,
                            method, reference, note, created_by)
      VALUES (${voucherNo}, ${input.kind}, ${input.partyKind}, ${input.partyRef},
              ${input.amountPaisa}, ${input.method ?? 'cash'},
              ${input.reference ?? null}, ${input.note ?? null}, ${input.by})
      RETURNING *`)).rows[0]

    /**
     * A receipt from a customer reduces what they owe, so it is a credit on
     * their ledger. A payment to a supplier reduces what we owe them, which
     * is a debit on theirs. Getting these the wrong way round is the classic
     * mistake and it shows up as balances that grow when they should shrink.
     */
    await postLedger({
      tx, partyKind: input.partyKind, partyRef: input.partyRef,
      description: `${input.kind === 'receipt' ? 'Received' : 'Paid'} — ${voucherNo}` +
        (input.reference ? ` (${input.reference})` : ''),
      debitPaisa: input.kind === 'payment' ? input.amountPaisa : 0,
      creditPaisa: input.kind === 'receipt' ? input.amountPaisa : 0,
      source: 'payment', sourceId: v.id, by: input.by
    })
    return v
  })
}

/* ------------------------------------------------------------ pricing */

/**
 * Reprice a product, and keep the old numbers.
 *
 * Nothing already sold or received is touched: sale and purchase lines
 * snapshot their own rates. This only changes what happens next.
 */
export async function repriceProduct(productId: number, b: {
  purchasePaisa?: number; tradePaisa?: number; retailPaisa?: number
  reason?: string | null; by: string
}) {
  return db.transaction(async (tx) => {
    const before = ((await tx.execute(sql`
      SELECT * FROM products WHERE id = ${productId}`)).rows as any[])[0]
    if (!before) throw new PharmaError('Medicine not found', 'NOT_FOUND')

    const next = {
      purchase: b.purchasePaisa ?? Number(before.purchase_paisa),
      trade: b.tradePaisa ?? Number(before.trade_paisa),
      retail: b.retailPaisa ?? Number(before.retail_paisa)
    }
    const changed = next.purchase !== Number(before.purchase_paisa)
      || next.trade !== Number(before.trade_paisa)
      || next.retail !== Number(before.retail_paisa)
    if (!changed) return before

    await tx.execute(sql`
      UPDATE products SET purchase_paisa = ${next.purchase},
             trade_paisa = ${next.trade}, retail_paisa = ${next.retail},
             updated_at = now()
      WHERE id = ${productId}`)

    await tx.execute(sql`
      INSERT INTO price_history
        (product_id, old_purchase_paisa, new_purchase_paisa, old_trade_paisa, new_trade_paisa,
         old_retail_paisa, new_retail_paisa, changed_by, reason)
      VALUES (${productId}, ${Number(before.purchase_paisa)}, ${next.purchase},
              ${Number(before.trade_paisa)}, ${next.trade},
              ${Number(before.retail_paisa)}, ${next.retail},
              ${b.by}, ${b.reason ?? null})`)

    return ((await tx.execute(sql`SELECT * FROM products WHERE id = ${productId}`)).rows as any[])[0]
  })
}

export async function priceHistory(opts: { productId?: number; from?: string; to?: string } = {}) {
  let where = sql`true`
  if (opts.productId) where = sql`${where} AND h.product_id = ${opts.productId}`
  if (opts.from && opts.to) {
    where = sql`${where} AND h.changed_at >= ${opts.from}::date
                       AND h.changed_at < (${opts.to}::date + interval '1 day')`
  }
  const r = await db.execute<any>(sql`
    SELECT h.*, p.name AS product_name, p.pack_label
    FROM price_history h JOIN products p ON p.id = h.product_id
    WHERE ${where} ORDER BY h.changed_at DESC LIMIT 400`)
  return r.rows
}

/* --------------------------------------------------------- permissions */

/**
 * Everything a pharmacy user can be allowed or refused.
 *
 * Listed here rather than derived from the screens so the admin page shows a
 * stable set of checkboxes, and so a permission that is not yet used by any
 * screen can still be granted in advance.
 */
export const PERMISSIONS: { group: string; key: string; label: string }[] = [
  { group: 'Selling', key: 'sale.counter',   label: 'Sell at the counter' },
  { group: 'Selling', key: 'sale.credit',    label: 'Sell on account (credit)' },
  { group: 'Selling', key: 'sale.discount',  label: 'Give a discount' },
  { group: 'Selling', key: 'sale.cancel',    label: 'Cancel an invoice' },
  { group: 'Selling', key: 'sale.return',    label: 'Take goods back' },
  { group: 'Selling', key: 'sale.reprint',   label: 'Reprint an invoice' },
  { group: 'Selling', key: 'sale.estimate',  label: 'Write an estimate' },

  { group: 'Buying',  key: 'purchase.receive', label: 'Receive a delivery' },
  { group: 'Buying',  key: 'purchase.return',  label: 'Return goods to a supplier' },
  { group: 'Buying',  key: 'purchase.view',    label: 'See purchase history' },

  { group: 'Stock',   key: 'stock.view',     label: 'See stock levels' },
  { group: 'Stock',   key: 'stock.adjust',   label: 'Adjust stock after a count' },
  { group: 'Stock',   key: 'stock.expiry',   label: 'Write off expired stock' },

  { group: 'Masters', key: 'product.add',    label: 'Add a medicine' },
  { group: 'Masters', key: 'product.edit',   label: 'Edit a medicine' },
  { group: 'Masters', key: 'product.price',  label: 'Change prices' },
  { group: 'Masters', key: 'party.manage',   label: 'Manage customers and suppliers' },

  { group: 'Money',   key: 'ledger.view',    label: 'See ledgers and balances' },
  { group: 'Money',   key: 'payment.receive', label: 'Take a payment from a customer' },
  { group: 'Money',   key: 'payment.pay',    label: 'Pay a supplier' },

  { group: 'Reports', key: 'report.sales',    label: 'Sales reports' },
  { group: 'Reports', key: 'report.purchase', label: 'Purchase reports' },
  { group: 'Reports', key: 'report.profit',   label: 'Profit and margin reports' },
  { group: 'Reports', key: 'report.stock',    label: 'Stock reports' },
  { group: 'Reports', key: 'report.ledger',   label: 'Ledger and party reports' },
  { group: 'Reports', key: 'report.export',   label: 'Export a report to a file' },

  { group: 'Staff',   key: 'staff.access',   label: 'Decide what other staff can do' }
]

/** Sensible starting point for a new user, by role. */
const ROLE_DEFAULTS: Record<string, string[]> = {
  /**
   * What a counter assistant gets on day one. Everything else — discounts,
   * cancellations, margins, ledgers, other people's access — is granted
   * deliberately rather than inherited.
   */
  pharmacist: ['sale.counter', 'sale.reprint', 'sale.estimate', 'purchase.receive',
               'purchase.view', 'stock.view', 'product.add', 'product.edit',
               'report.sales', 'report.stock'],
  pharmacy_admin: PERMISSIONS.map((p) => p.key),
  admin: PERMISSIONS.map((p) => p.key)
}

/**
 * Everyone who can open the pharmacy.
 *
 * Its own query rather than the admin staff list, because a pharmacy
 * administrator is not a hospital administrator: they may set what their own
 * counter staff can do and nothing else. Reusing /staff would have meant
 * giving them the doctors, the cashiers and the power to create accounts.
 */
export async function pharmacyStaff() {
  const r = await db.execute<any>(sql`
    SELECT st.id, st.username, st.display_name, st.role, st.is_active,
           (SELECT COUNT(*)::int FROM staff_permissions sp WHERE sp.staff_id = st.id)
             AS overrides
    FROM staff st
    WHERE st.role IN ('pharmacist', 'pharmacy_admin', 'admin') AND st.is_active
    ORDER BY st.role = 'admin', st.display_name`)
  return r.rows
}

/** Does this person hold a given permission right now? */
export async function hasPermission(staffId: number, key: string) {
  const { allowed } = await permissionsFor(staffId)
  return allowed.includes(key)
}

export async function permissionsFor(staffId: number) {
  const staff = ((await db.execute(sql`
    SELECT id, username, display_name, role FROM staff WHERE id = ${staffId}`)).rows as any[])[0]
  if (!staff) throw new PharmaError('Staff member not found', 'NOT_FOUND')

  const set = new Set((ROLE_DEFAULTS[staff.role] ?? []))
  const overrides = (await db.execute<any>(sql`
    SELECT * FROM staff_permissions WHERE staff_id = ${staffId}`)).rows as any[]
  for (const o of overrides) {
    if (o.allowed) set.add(o.permission)
    else set.delete(o.permission)
  }
  return { staff, allowed: [...set], overrides }
}

export async function savePermissions(staffId: number, allowed: string[]) {
  const staff = ((await db.execute(sql`
    SELECT role FROM staff WHERE id = ${staffId}`)).rows as any[])[0]
  if (!staff) throw new PharmaError('Staff member not found', 'NOT_FOUND')
  const defaults = new Set(ROLE_DEFAULTS[staff.role] ?? [])
  const want = new Set(allowed)

  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM staff_permissions WHERE staff_id = ${staffId}`)
    /**
     * Only the differences from the role default are stored. That way
     * changing what a role means later still reaches everyone who never had
     * their boxes touched individually.
     */
    for (const p of PERMISSIONS) {
      const should = want.has(p.key)
      if (should !== defaults.has(p.key)) {
        await tx.execute(sql`
          INSERT INTO staff_permissions (staff_id, permission, allowed)
          VALUES (${staffId}, ${p.key}, ${should})`)
      }
    }
    return permissionsFor(staffId)
  })
}
