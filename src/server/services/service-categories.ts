import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Service categories: the groups tests, scans and procedures are filed under.
 *
 * Rows, so a hospital can add "Dental procedures" and map it to its Dental
 * department without anyone changing the software. Every screen that used to
 * carry its own copy of "lab, radiology, procedure, other" — the Services
 * tabs, the Main Counter's boxes, the walk-in test filter — reads this list.
 *
 * Each category has a `kind`, one of the four the system has always known
 * (lab, radiology, procedure, other). The kind is what decides behaviour:
 * lab and radiology results are entered on their own screens, and the
 * earnings report splits on it. It is copied onto every service saved under
 * the category (services.category), so none of those rules had to learn that
 * categories became rows. See drizzle/0040.
 *
 * The department is what the token queue and the department reports use. A
 * service in a mapped category always belongs to that department; in an
 * unmapped one it may name its own, as it could before.
 */

export type ServiceKind = 'lab' | 'radiology' | 'procedure' | 'other'
export const SERVICE_KINDS: ServiceKind[] = ['lab', 'radiology', 'procedure', 'other']

export class CategoryError extends Error {
  constructor(msg: string, public code:
    'NOT_FOUND' | 'DUPLICATE' | 'IN_USE' | 'BUILTIN' | 'BAD_DEPARTMENT' | 'INACTIVE') {
    super(msg)
  }
}

export async function listCategories(includeInactive = false) {
  return (await db.execute<any>(sql`
    SELECT sc.*, d.name AS department_name,
           (SELECT COUNT(*)::int FROM services sv WHERE sv.category_id = sc.id) AS service_count,
           (SELECT COUNT(*)::int FROM services sv
            WHERE sv.category_id = sc.id AND sv.is_active AND sv.price_paisa > 0) AS orderable_count
    FROM service_categories sc
    LEFT JOIN departments d ON d.id = sc.department_id
    WHERE ${includeInactive ? sql`true` : sql`sc.is_active`}
    ORDER BY sc.sort_order, lower(sc.name), sc.id`)).rows
}

export async function getCategory(tx: any, id: number) {
  return ((await tx.execute(sql`
    SELECT * FROM service_categories WHERE id = ${id}`)).rows as any[])[0] ?? null
}

/** The built-in category for a kind: where a service with no category belongs. */
export async function builtinCategoryFor(tx: any, kind: string) {
  return ((await tx.execute(sql`
    SELECT * FROM service_categories WHERE kind = ${kind}::service_category
    ORDER BY is_builtin DESC, id LIMIT 1`)).rows as any[])[0] ?? null
}

export async function saveCategory(input: {
  id?: number
  name: string
  departmentId: number | null
  kind?: ServiceKind
  isActive?: boolean
}) {
  const name = input.name.trim().replace(/\s+/g, ' ')
  return db.transaction(async (tx) => {
    /*
     * Names are compared the way the unique index compares them — trimmed and
     * case-blind — so "Dental" and "dental " are one category, and the person
     * hears that in words rather than as a constraint violation.
     */
    const clash = ((await tx.execute(sql`
      SELECT id, name FROM service_categories
      WHERE lower(btrim(name)) = lower(${name})
        ${input.id ? sql`AND id <> ${input.id}` : sql``}`)).rows as any[])[0]
    if (clash) {
      throw new CategoryError(`There is already a category called "${clash.name}"`, 'DUPLICATE')
    }

    if (input.departmentId != null) {
      const dept = ((await tx.execute(sql`
        SELECT id FROM departments WHERE id = ${input.departmentId} AND is_active`)).rows as any[])[0]
      if (!dept) {
        throw new CategoryError('That department does not exist or is switched off', 'BAD_DEPARTMENT')
      }
    }

    if (input.id) {
      const before = await getCategory(tx, input.id)
      if (!before) throw new CategoryError('Category not found', 'NOT_FOUND')
      /*
       * The kind of a category in use is fixed. Changing it would turn every
       * lab test under it into a procedure on the spot, moving finished
       * reports off the laboratory's screen; somebody who wants that makes a
       * new category and moves the services across one by one.
       */
      const inUse = Number(((await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM services WHERE category_id = ${input.id}`)).rows as any[])[0].n)
      const kind = inUse > 0 ? before.kind : (input.kind ?? before.kind)
      if (before.is_builtin && input.isActive === false) {
        throw new CategoryError(
          'The four built-in categories cannot be switched off. Rename it instead.', 'BUILTIN')
      }
      const row = ((await tx.execute(sql`
        UPDATE service_categories SET
          name = ${name},
          department_id = ${input.departmentId},
          kind = ${before.is_builtin ? before.kind : kind}::service_category,
          is_active = ${input.isActive ?? before.is_active}
        WHERE id = ${input.id} RETURNING *`)).rows as any[])[0]

      /*
       * Re-mapping a category moves its services with it, so the department
       * on a service can never disagree with its category's. Unmapping it
       * leaves each service's own department where it was.
       */
      if (input.departmentId != null) {
        await tx.execute(sql`
          UPDATE services SET department_id = ${input.departmentId}
          WHERE category_id = ${input.id}`)
      }
      await tx.execute(sql`
        UPDATE services SET category = ${row.kind}::service_category
        WHERE category_id = ${input.id} AND category <> ${row.kind}::service_category`)
      return row
    }

    return ((await tx.execute(sql`
      INSERT INTO service_categories (name, kind, department_id, sort_order)
      VALUES (${name}, ${input.kind ?? 'procedure'}::service_category, ${input.departmentId},
              COALESCE((SELECT MAX(sort_order) FROM service_categories), 40) + 10)
      RETURNING *`)).rows as any[])[0]
  })
}

/**
 * Delete a category nothing is filed under.
 *
 * Refused while any service — switched off or not — still points at it,
 * because those services' bills and reports would lose their group. Moving
 * them first is the way out, and the message says so.
 */
export async function deleteCategory(id: number) {
  return db.transaction(async (tx) => {
    const row = await getCategory(tx, id)
    if (!row) throw new CategoryError('Category not found', 'NOT_FOUND')
    if (row.is_builtin) {
      throw new CategoryError('The four built-in categories cannot be deleted', 'BUILTIN')
    }
    const used = Number(((await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM services WHERE category_id = ${id}`)).rows as any[])[0].n)
    if (used > 0) {
      throw new CategoryError(
        `${used} service(s) are filed under this category. Move them to another category ` +
        'first, or switch the category off instead.', 'IN_USE')
    }
    await tx.execute(sql`DELETE FROM service_categories WHERE id = ${id}`)
    return { deleted: true }
  })
}

/**
 * Put every service without a category into the built-in one for its kind.
 *
 * Migration 0040 does this once. It is needed again after restoring a backup
 * taken before categories existed: those services come back with no
 * category_id, and without this they would vanish from every category tab.
 */
export async function linkUncategorisedServices(tx: any = db) {
  await tx.execute(sql`
    UPDATE services sv SET category_id = (
      SELECT sc.id FROM service_categories sc
      WHERE sc.kind = sv.category
      ORDER BY sc.is_builtin DESC, sc.id LIMIT 1)
    WHERE sv.category_id IS NULL`)
}
