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

/*
 * The role lists the API will actually accept.
 *
 * This was the one place not checked, and it is the place that breaks: the
 * dropdown offered 'kiosk', the database knew 'kiosk', and the staff route
 * rejected it with a wall of zod enum text. Every list agreed except the one
 * standing between the form and the table.
 *
 * There are two of these, one for creating staff and one for editing, and
 * they are checked separately because adding a role to one and not the other
 * is the same bug a turn later.
 */
const apiSrc = read('src/server/api/index.ts')
const apiEnums = [...apiSrc.matchAll(/role:\s*z\.enum\(\[([\s\S]*?)\]\)/g)]
  .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))

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
check('the API has a role list to check at all', apiEnums.length >= 2 ? [] : ['none found'])
apiEnums.forEach((list, i) => {
  check(`the API accepts every role (list ${i + 1} of ${apiEnums.length})`,
    serverEnum.filter((r) => !list.includes(r)))
})

/*
 * The door terminal is denied by default.
 *
 * Every other role is allowed unless a route refuses it, which suits a person
 * at a keyboard. The kiosk is a browser left signed in forever in a corridor,
 * so it is the other way round: a short list of what it MAY reach, and a
 * route added next month is invisible to it until somebody decides otherwise.
 *
 * Checked here because the first version got this wrong — patient search
 * answered a kiosk token with 200 — and the next route to be added would do
 * the same thing.
 */
const kioskGuard = /role === 'kiosk'[\s\S]{0,400}?ALLOWED\s*=\s*\[([^\]]*)\]/.exec(apiSrc)
check('the attendance board is denied by default', kioskGuard ? [] : ['no guard found'])
if (kioskGuard) {
  const allowed = [...kioskGuard[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  /* It needs the board. Anything beyond the four below is worth questioning. */
  check('and may still read the board',
    allowed.includes('/attendance/recent') ? [] : ['/attendance/recent'])
  check('and reaches nothing beyond what it needs',
    allowed.filter((a) => ![
      '/attendance/recent', '/auth/me', '/auth/logout', '/modules'].includes(a)))
}

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
