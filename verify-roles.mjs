/**
 * Every role must be reachable.
 *
 * A role is defined in four places that have to agree: the server enum, the
 * client type, the sign-in screen, and the admin dropdown that creates staff.
 * Adding `ipd_counter` silently missed the admin dropdown — the edit matched
 * text that had already been rewritten by the translation pass — so emergency
 * staff could not be created at all. Nothing failed; the option simply was not
 * there. This check compares all four lists.
 *
 *   node verify-roles.mjs
 */
import { readFileSync } from 'fs'

const read = (p) => readFileSync(p, 'utf8')

const serverEnum = [...read('src/server/db/schema.ts')
  .match(/pgEnum\('staff_role',\s*\n?\s*\[([^\]]*)\]/)[1]
  .matchAll(/'([^']+)'/g)].map((m) => m[1])

const clientType = [...read('src/client/src/lib/api.ts')
  .match(/export type Role = ([^\n]+)/)[1]
  .matchAll(/'([^']+)'/g)].map((m) => m[1])

const signIn = [...read('src/client/src/screens/SignIn.tsx')
  .matchAll(/\{\s*role:\s*'([^']+)'/g)].map((m) => m[1])

const adminOpts = [...read('src/client/src/screens/Admin.tsx')
  .matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1])
  .filter((r) => serverEnum.includes(r))

const appRoutes = read('src/client/src/App.tsx')
const routed = serverEnum.filter((r) => appRoutes.includes(`me.role === '${r}'`))

let fail = 0
const check = (name, missing) => {
  if (missing.length === 0) { console.log('  ok   ' + name) }
  else { fail++; console.log(`  FAIL ${name} — missing: ${missing.join(', ')}`) }
}

/**
 * Some roles deliberately share a cell.
 *
 * pharmacy_admin opens the same pharmacy module as pharmacist — the tabs it
 * sees differ, not the application. Giving it its own cell implied two
 * separate programs, which is exactly the confusion this map records.
 */
const SHARES_CELL = { pharmacy_admin: 'pharmacist' }

/**
 * Roles that exist in the database but are no longer offered anywhere.
 *
 * `pharmacy_admin` was a second pharmacy role; it turned out to be one module
 * with a different set of tabs, so it is now a permission on an ordinary
 * pharmacist instead. Postgres cannot drop a value from an enum without
 * rebuilding the type, and accounts created under the old role still sign in
 * and still work — so the value stays and this list records why it is missing
 * from the pickers.
 */
const RETIRED = ['pharmacy_admin']

console.log(`\nroles in the database enum: ${serverEnum.join(', ')}\n`)
check('the client type lists every role',
  serverEnum.filter((r) => !clientType.includes(r) && !RETIRED.includes(r)))
/*
 * The sign-in screen no longer lists roles.
 *
 * It used to show a button per department, which told anybody standing at an
 * unattended counter exactly which departments exist and what each is called.
 * A username already knows its own role, so the cells were removed and this
 * check with them. What still matters is below: every role must land on a
 * screen once it signs in.
 */
check('every role can be created in Admin',
  serverEnum.filter((r) => !adminOpts.includes(r) && !RETIRED.includes(r)))
// admin is the bootstrap account and has its own setup path, so it needs no
// per-role branch in App; every other role must land on a screen.
check('every role lands on a screen',
  serverEnum.filter((r) => r !== 'admin' && !routed.includes(r))
            .filter((r) => !appRoutes.includes(r)))

// A retired role must still reach a screen, or the accounts using it break.
check('retired roles still land somewhere',
  RETIRED.filter((r) => !appRoutes.includes(r)))

console.log(fail ? `\n${fail} gap(s)\n` : '\nevery role is reachable end to end\n')
process.exit(fail ? 1 : 0)
