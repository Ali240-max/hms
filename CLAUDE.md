# CLAUDE.md

Hospital Management System for a Pakistani hospital: OPD, main/cash counter, emergency, IPD/wards, lab, radiology, pharmacy, stores, reports, staff attendance. One Node server + one PostgreSQL database on a Windows machine on the hospital LAN; every other PC uses a browser. Deployments are often **offline** (no internet on site).

The README's "What is not built yet" section is out of date (pharmacy billing, lab results, printing and IPD all exist now).

## Stack

- **Server:** Node (≥20; dev machine has 22) + **Hono** (`@hono/node-server`), not Express. TypeScript run with `tsx` in dev, bundled with esbuild for production.
- **DB:** PostgreSQL via `pg` Pool + `drizzle-orm` (node-postgres). Mostly raw SQL through `db.execute(sql\`...\`)`.
- **Client:** React 18 + Vite 5 + Tailwind 3, `framer-motion`, `lucide-react`, `recharts`, `zustand` (cart). No router.
- **Validation:** `zod` in route handlers. **PDFs:** `pdfkit` on the server. **Thermal printing:** ESC/POS bytes from the server.
- **Attendance agent:** separate C# exe in `agent/` (ZKTeco USB readers or K50 network terminals), built with `agent/build.bat`.

## Commands

```bash
npm run dev            # scripts/dev.mjs: tsx watch server (:4000) + vite client (:5173, proxies /api to 127.0.0.1:4000)
npm run build          # vite build -> dist/client, esbuild -> dist/server/index.js
npm start              # node dist/server/index.js — serves API and built client on :4000
npm run typecheck      # tsc for server and client configs (both noEmit). Run before every deploy.
npm run setup          # interactive: creates PG role/db if missing, writes .env
npm run bundle         # builds, then writes hms-offline.zip with only runtime node_modules
npm run verify         # scripts/verify-all.mjs: "offline" suites, then HTTP suites if a server is up
npm run verify:<name>  # single suite, e.g. verify:i18n, verify:roles, verify:billing
```

Use `;` not `&&` in Windows PowerShell 5.1. There is no test framework: tests are standalone `verify-*.{ts,mjs}` scripts in the repo root that print `ok`/`FAIL` lines.

### Test safety — read before running anything

- `verify-opd.ts` and `verify-api.ts` **TRUNCATE core tables** (patients, visits, staff, sales, …) in whatever `DATABASE_URL` points to. Never run them against a real database.
- Many "offline" suites in `verify-all` (ipd, attendance, audit, ordering, writeoff, demo, crossmatch, layouts) import `src/server/db/client` and **write to the database**. "Offline" only means "no HTTP server needed".
- HTTP suites (`verify-billing.mjs`, etc.) create records through the API and sign in with demo-seed accounts, so they assume a seeded dev database.
- `npm run seed -- --reset` and Administration → Demo data (reset) wipe and recreate data, including staff.
- `verify-queues.mjs` with `VERIFY_RESTORE=1` (and Administration → Settings → Restore from backup) **replaces the entire database** with a backup. Without the flag it only creates records, like the other HTTP suites.
- Safe with no DB: `typecheck`, `verify:i18n`, `verify:render`, `verify:tabs`, `verify:lan`, `verify:roles` (source/render checks; confirm before relying on this for any other suite). `verify:tabs` has one check that fails on Windows (it matches `screens/` with a forward slash).
- To run DB suites without touching the dev database, start a throwaway cluster (`initdb` + `pg_ctl` from `C:\Program Files\PostgreSQL\18\bin`, on another port) and set `DATABASE_URL` to it — real environment variables win over `.env`.

## Layout

```
src/server/index.ts          Hono app, mounts /api, serves dist/client, runs migrations, starts backup timer
src/server/env.ts            hand-written .env loader (real env vars win), safeUrl() hides passwords in logs
src/server/db/client.ts      pool, drizzle instance, runMigrations(), nextCounter()
src/server/db/schema.ts      Drizzle schema — PARTIAL, see Database
src/server/api/index.ts      auth middleware, role guards, error mapping, ~190 routes
src/server/api/pharmacy.ts   /api/pharmacy — the till (sales, FEFO, goods receipt)
src/server/api/pharma.ts     /api/pharma   — pharmacy masters, ledgers, returns, ordering, reports
src/server/api/reports.ts    /api/reports  — report catalogue, per-role access
src/server/services/*.ts     all business logic; route handlers stay thin
src/client/src/App.tsx       picks the screen from the signed-in role
src/client/src/screens/      one top-level screen per role, sub-folders for tabs
src/client/src/components/   ui.tsx (Card, Stat, Field, Badge, Modal, Empty, Th, ErrorNote, LoadingBar, SkeletonRows, Tabs, PrintButton), Sidebar, Combobox, print slips
src/client/src/lib/          api.ts (fetch wrapper + every endpoint + money helpers), prefs.tsx (theme + Urdu dictionary), modules.tsx, printer.ts, motion.tsx, toast.tsx, cart.ts
drizzle/                     NNNN_name.sql migrations, applied at server start
agent/                       C# attendance agent
.rendercheck/                mounts every screen under Node to catch render crashes
```

## Backend conventions

- **Auth:** `Authorization: Bearer <token>`. Sessions in the `sessions` table with an in-memory cache, 12-hour expiry; falls back to memory-only if the table is unusable. Passwords use scrypt (`scrypt$salt$hash`). There are no default accounts: first run creates the admin through `/auth/setup`.
- **Public routes** are an explicit allow-list in the `api.use('*')` middleware (`/health`, `/auth/status|login|setup`, `GET /modules`). Attendance-agent routes authenticate with `x-device-key` and are listed by exact path. Add any new public path there deliberately, by exact path and never by prefix.
- **Authorization is server-side.** Use `allow(...roles)`, `adminOnly`, or `adminCan('admin.<perm>')` (per-admin permissions in `services/admin-perms.ts`; the first/root admin cannot be restricted). Pharmacy has its own permission list (`services/pharma.ts` `hasPermission`). Hiding a tab in the client is never the control.
- **`kiosk` role is deny-by-default:** only the paths in its `ALLOWED` list. Every other role is allow-by-default, so a new route needs its own guard.
- **Identity comes from the session**, never the request body (e.g. the prescribing doctor = `me(c).doctorId`). Use `me(c)` to read it.
- **Roles** (`staff_role` enum): admin, main_counter, receptionist (= OPD counter), ipd_counter (= emergency), ward, kiosk, store_keeper, lab_tech, radiology, doctor, pharmacist, pharmacy_admin (legacy, routed to Pharmacy), reports. Keep the `Role` types in `services/auth.ts` and `client/src/lib/api.ts` in sync.
- **Errors:** services throw domain errors with a `code` (`PatientError`, `BillError`, `LabError`, `StockError`, …). `api.onError` maps them to `{ error, code }` with 404 for `NOT_FOUND` and 409 otherwise; `ZodError` → 400 `INVALID_INPUT` with `field`. A new error class must be added to the relevant `onError`, or it surfaces as a 500. Sub-routers have their own `onError`.
- **File downloads/PDFs:** the browser cannot send the bearer header, so the client calls `openDocument(path)`, which gets a one-minute ticket from `POST /tickets`. Ticket paths must match the regex in that route (`/(lab|pharma|reports|patients|visits)/…/pdf`).
- `BUILD` constant in `api/index.ts` (currently a hand-set `vN`) is shown in the UI top bar with the last migration, so staff can confirm which update is running. Bump it with each release bundle.
- Archive staff/records instead of deleting them when history references them. Several delete paths refuse with `HAS_HISTORY` / `IN_USE`.

## Database rules

- **Migrations are hand-written SQL** in `drizzle/NNNN_name.sql`. Only `0000` was generated; `drizzle/meta/_journal.json` lists only that one. **Do not run `npm run db:generate` / drizzle-kit** — the snapshot is stale and it would emit a wrong diff.
- `runMigrations()` (custom, not drizzle-kit migrate) runs each unapplied file **in one transaction**, splitting on `--> statement-breakpoint`, and records it in `_migrations`. A failed migration stops the server from starting.
- New migration = next number, idempotent DDL (`IF NOT EXISTS`), a header comment explaining why, and nothing that relies on being run outside a transaction (e.g. no `CREATE INDEX CONCURRENTLY`, no `ALTER TYPE … ADD VALUE` used in the same file). Never edit an applied migration.
- **`schema.ts` is partial:** 40 of the 66 tables (lab, IPD, attendance, counter bills, sessions, audits, write-offs, returns, ledgers, …) and some later columns (e.g. `staff.shift_*`, `device_user_id`) exist only in SQL. Query those with `sql\`\``, and don't assume a table is absent because it is missing from `schema.ts`.
- **Money is integer paisa** (`*_paisa`), **percentages are basis points** (`*_bp`, 2000 = 20%). No floats. Client helpers: `rs()`, `toPaisa()`, `bpToPct()`, `pctToBp()`.
- Type parsers: `DATE` stays a `'YYYY-MM-DD'` string; `BIGINT` is parsed to `Number`.
- **Numbering:** `nextCounter(tx, key)` is a gapless, row-locked counter. Use `documentNo(tx, { prefix, letter })` → `INV-YYMMDD-C00123` (daily reset) and `nextMrn(tx)` → `MRN-000123`. Always call these inside the transaction that writes the document.
- **Transactions:** `db.transaction(async (tx) => …)` for any multi-row write; pass `tx` down. Stock allocation locks batches `FOR UPDATE` in FEFO order (`services/sales.ts`). Do not use `SKIP LOCKED` there.
- **Tokens** are per department per local day: `nextToken(tx, queueFor(departmentId, fallback))` in `services/numbering.ts`. A doctor visit uses the doctor's department (else `opd`); a chit carries its own department token (`chits.token_no`, raised only in `chits.ts` `raiseChits`); emergency has its own queue. Old chits have NULL and display the visit token.
- **Service categories** are rows (`service_categories`, each mapped to a department). `services.category` (the old enum) stays as the category's *kind* and still drives lab/radiology/procedure behaviour; saving a service copies kind and (if mapped) department from its category.
- Prices and doctor shares are **snapshotted** on orders. Doctor earnings are a ledger with a unique `(source, ref_table, ref_id)` so a re-save can't pay twice. Prescribed and dispensed quantities are separate.
- Backups: every 12 h, NDJSON.gz of every public table to `BACKUP_DIR` (default `./backups`), keep 14, plus an optional extra directory set in Settings.

## Frontend conventions

- **No router.** `App.tsx` switches on `me.role`; each role screen has its own side rail (`components/Sidebar`) or `Tabs`. `ModuleGate` hides a role's screen when its module is switched off in Settings. Switching a module off is display-only.
- Token is held **in memory only** (closing the tab signs out). Any 401 outside `/auth` calls the signed-out handler. Every request also sends `X-Device-Id` (per-PC id in localStorage, used to pick that PC's printer).
- **Colours come only from CSS variables** (`--c-*` RGB triplets in `index.css`) exposed as Tailwind tokens: `primary accent screen card raised line divide heading body muted ok warn bad`. Use these and never raw hex/Tailwind palette colours, or the three themes (`classic` default, `slate`, `dark`, set as a class on `<html>`) break.
- Component classes in `index.css`: `.card .panel .card-tint .field .btn-primary .btn-ghost .tile .label .thead-strip .rows-striped .section-head .num`, motion `.anim-in .anim-fade .anim-pop .anim-rows .loading-bar .skeleton .lift`, print `.no-print .print-area`. Borders are 2px `border-line`; cards `rounded-2xl`, panels `rounded-3xl`, fields/buttons `rounded-xl`; text size `text-2xs` for secondary text.
- The `bg-brand` gradient is only for primary buttons and small icon tiles. Numeric results are `primary`/`accent`, never near-black. Use `.num` (tabular figures) for numbers.
- Fonts are bundled (`@fontsource/inter`, `noto-nastaliq-urdu`). Never load anything from a CDN, because the site may be offline.
- **i18n:** wrap every user-facing string as `tr('English text')` (`const tr = useT()` or the bare `t()` export). Keys are the English text; add the Urdu entry to the `UR` dictionary in `lib/prefs.tsx`. `npm run verify:i18n` fails on any missing key. Layout stays LTR in Urdu; clinical shorthand, drug names and legal print stay English.
- Served over plain HTTP on the LAN, so it is **not a secure context**: no `crypto.randomUUID()` (use `newId()`), no clipboard/secure-only APIs.
- Respect reduced motion (`MotionConfig reducedMotion="user"` + CSS media query). Animations are short and play once.
- Target screens are ~1366px wide counter monitors.

## Attendance

- `services/attendance.ts`. Punches are facts in `attendance_events`; **direction is never stored**. `readDay`/`directionOf` derive it from a punch's position in its `work_date` in time order: 1st in, 2nd out, 3rd in… Time on site = sum of in→out pairs. Late applies only to the day's first check-in.
- `recordPunch` runs in a transaction holding `pg_advisory_xact_lock(30, staff_id)`; the ±5-minute repeat window and the insert happen under it. Keep any new punch-writing path inside that function.
- Dates: server-local calendar (`todayLocal()`, `workDateFor` for night shifts), never `toISOString().slice(0,10)`.
- C# agent in `agent/` (.NET Framework 4, C# 5 — no interpolation or `?.`; builds with `build.bat`). Reader mode: USB Live20R matched on the PC; capture decisions live in SDK-free `Scan.cs`. Terminal mode: K50 over TCP 4370 (`Terminal.cs`). Test with `agent\test-protocol.bat` (fake device on loopback; `AgentTest.cs`).
- Creating staff on a K50: `services/terminal-sync.ts` queues `attendance_device_jobs`; the terminal agent claims them (`/attendance/agent/jobs`), runs them on its polling thread (never a second device connection), and reports (`/attendance/agent/job-result`). A device user already under an id is never overwritten; only a confirmed read-back maps `staff.device_user_id`. No templates are sent to the K50.

## Printing

- Thermal receipts: the **server** builds ESC/POS (`services/escpos.ts`) and sends it (`services/printing.ts`) to a network printer (port 9100), a Windows share (`copy /b`), or a local share. Config is per module and per device id.
- Browser printing (fallback / A4): `lib/printer.ts` prints a slip from an off-screen iframe. Don't reintroduce printing the app document with print CSS.
- A4 documents (lab reports, labels, POs, audits) are pdfkit PDFs opened with `openDocument`. See `DEPLOY-PRINTING.md`.

## Deployment constraints

- Windows server, PostgreSQL 17, service via **NSSM** (`AppDirectory` must be the app folder, or `.env` is not found). `ecosystem.config.cjs` (pm2) exists for Linux. Run **one process only**: there is an in-memory session cache and a backup timer.
- Server binds `0.0.0.0:PORT` (default 4000). In dev Vite proxies to `127.0.0.1`, not `localhost` (IPv6 issue on Windows).
- **Offline install:** `npm run bundle` → `hms-offline.zip` (dist, drizzle, scripts, runtime-only node_modules, `START.bat`, `VERSION.txt`). Bundled `seed` scripts use `node --experimental-strip-types`, so they need Node ≥22.6. Upgrade = backup, stop service, delete `dist` and `node_modules`, unzip, start; migrations apply on start. See `DEPLOY-WINDOWS-OFFLINE.md`, `UPGRADING-WINDOWS.md`.
- Env vars: `DATABASE_URL`, `PORT`, optional `BACKUP_DIR` (see `.env.example`). `.env` is gitignored. Never print or commit its values. Use `safeUrl()` when logging a connection string.
- Don't deploy during clinic hours. Always take a `pg_dump` before an upgrade.

## Working rules

- Code comments here are long and explain *why* (often citing a past incident). Match that style for non-obvious decisions, and don't strip existing ones.
- Business rules live in services and are enforced on the server, never only in the client.
- Don't touch production data. Don't run destructive verify suites, seed `--reset`, or wipe routes against anything but a throwaway dev database.
