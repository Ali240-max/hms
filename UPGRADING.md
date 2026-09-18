# Upgrading a hospital that is already live

The short version:

```bash
cd ~/hms
pm2 stop hms            # or: Stop-Service hms
git pull
npm install             # only if package.json changed
npm run build
pm2 start hms           # or: Start-Service hms
```

Downtime is seconds. Everything below is about the parts worth understanding
before you do it on a machine a hospital depends on.

---

## Before you touch anything: take a backup

```bash
pg_dump -U hms hms | gzip > ~/before-upgrade-$(date +%F-%H%M).sql.gz
```

The server also writes its own backup every 12 hours, but take one immediately
before an upgrade regardless. It costs ten seconds and it is the difference
between a bad afternoon and a catastrophe.

---

## What happens to the database

Migrations live in `drizzle/` and run automatically when the server starts.
Each file runs **inside one transaction**, so a migration either applies
completely or not at all — there is no half-applied schema to unpick. The
server records which files it has already run and never runs one twice.

If a migration fails the server refuses to start and prints which file broke.
That is deliberate: a server running against a schema it does not understand
corrupts data quietly, while a server that will not start is obvious and
recoverable.

**Recovering from a failed migration:**

```bash
git checkout <previous-tag>     # go back to the version that was working
npm run build
pm2 start hms
```

The old code runs against the old schema, because the failed migration rolled
back. Then send me the error.

### Migrations that need more care

Most migrations add a table or a column; those are instant and safe on any
size of database. Two kinds are not:

- **Adding a NOT NULL column to a large table** rewrites every row and holds a
  lock while it does. On a hospital's data that is seconds, not minutes, but
  do it outside OPD hours.
- **Anything that drops or renames a column** loses data if you roll back
  afterwards. I write migrations to add rather than remove wherever possible,
  which is why `pharmacy_admin` still exists in the role list even though
  nothing offers it any more.

---

## What happens to the browser

Vite writes the client with a content hash in the filename
(`index-BsvXgub4.js`), so a new build produces a new filename and browsers
fetch it rather than serving a cached copy. Staff do **not** need to clear
their cache.

If a screen looks stale after an upgrade, it is almost always an old tab that
was open across the restart. Ctrl+Shift+R fixes it.

---

## Checks to run before you deploy, not after

From the folder you are about to install:

```bash
npm run typecheck        # both halves compile
npm run verify:render    # every screen renders in both languages
npm run verify:lan       # no browser APIs that break over plain HTTP
npm run verify:roles     # every role can sign in and be created
npm run verify:i18n      # no half-translated screens
```

None of these need a database or a running server. They take under a minute
between them and they catch the class of mistake that is invisible until a
receptionist hits it.

With the server running and demo data loaded, the rest are worth running on a
test machine:

```bash
npm run verify:billing verify:lab verify:pharmacy verify:returns \
        verify:supplies verify:emergency verify:chits verify:modules
```

**`verify-api.ts` and `verify-opd.ts` wipe the database they run against.**
Never point them at a hospital's server.

---

## Rolling back

```bash
cd ~/hms
pm2 stop hms
git checkout <previous-tag>
npm install
npm run build
pm2 start hms
```

This works as long as the upgrade did not drop or rename a column. If it did,
restore the backup you took at the start:

```bash
gunzip -c ~/before-upgrade-2026-09-18-1430.sql.gz | psql -U hms hms
```

Tag every release so there is something to check out:

```bash
git tag -a v1.1 -m "Lab grouping and module toggles"
git push --tags
```

---

## Turning modules on and off

Administration → Settings → **Modules in use**.

Switching a module off hides its sign-in cell and its buttons. It does not
delete anything, does not refuse an API call, and does not hide existing rows.
A hospital that starts with the main counter, laboratory and radiology can
switch the doctor terminal on in March and find its January data exactly where
it was.

This is a display decision, not a migration. That is the whole point of it.
