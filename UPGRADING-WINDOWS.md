# Upgrading the hospital's Windows server

PowerShell does not accept `&&`. Every command here is written to run as-is.

```powershell
cd C:\hms
Stop-Service hms
git pull
npm install
npm run build
Start-Service hms
```

Downtime is seconds. Everything below is the part worth understanding before
doing it on a machine a hospital depends on.

---

## PowerShell notes

`&&` chains commands in bash but is a syntax error in Windows PowerShell 5,
which is what ships with Windows 10. Use `;` to run regardless, or run the
commands one at a time.

```powershell
npm run typecheck ; npm run verify:render      # runs both, whatever happens
```

Stop-on-failure is not worth chaining for — read the output of the first
before running the second.

---

## Before you touch anything: take a backup

```powershell
cd C:\hms
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -U hms hms > "D:\hms-backups\before-upgrade-$stamp.sql"
```

It will ask for the `hms` password. Adjust the version number in the path to
match what is installed.

The server also writes a backup every 12 hours, but take one immediately
before an upgrade regardless. Ten seconds against a very bad afternoon.

---

## What happens to the database

Migrations live in `drizzle\` and run automatically when the service starts.
Each file runs **inside one transaction**, so a migration either applies
completely or not at all — there is never a half-applied schema to unpick. The
server records which files it has run and never runs one twice.

If a migration fails the server refuses to start and names the file. That is
deliberate: a server running against a schema it does not understand corrupts
data quietly, while one that will not start is obvious and recoverable.

**Recovering from a failed migration:**

```powershell
cd C:\hms
git checkout <previous-tag>
npm run build
Start-Service hms
```

The old code runs against the old schema, because the failed migration rolled
back.

---

## Checks to run before you deploy, not after

```powershell
cd C:\hms
npm run typecheck
npm run verify:render
npm run verify:lan
npm run verify:roles
npm run verify:i18n
```

None of these need a database or a running server, and between them they take
under a minute. **Run the typecheck every single time.** A file that does not
compile is the one class of problem that will take the whole hospital down,
and it is free to catch.

---

## Deploying an update, step by step

```powershell
# 1. Backup (above)

# 2. Stop the service so files are not locked
Stop-Service hms

# 3. Get the new code
cd C:\hms
git pull

# 4. Dependencies, only if package.json changed
npm install

# 5. Check it compiles BEFORE building
npm run typecheck

# 6. Build both halves
npm run build

# 7. Start
Start-Service hms

# 8. Confirm it came up
Get-Service hms
Invoke-WebRequest http://localhost:4000/api/health | Select-Object -Expand Content
```

If step 5 prints errors, **stop**. Do not build, do not start. Run
`Start-Service hms` to bring the old build back up and sort the errors out
first.

---

## If the service will not start

```powershell
Get-Content C:\hms\logs\err.log -Tail 40
```

The server prints a specific message for each common failure rather than a
stack trace.

**"Cannot reach the database"** — either PostgreSQL is not running
(`Get-Service postgresql*`), or the service's working directory is wrong. If
the error shows a connection string that is not the one in your `.env`, it is
the working directory: the service never read the file.

```powershell
cd C:\hms
.\nssm.exe set hms AppDirectory C:\hms
Restart-Service hms
```

**Service starts then stops immediately** — almost always a missing
`dist\server\index.js`. Run `npm run build`.

**A screen is blank and white** — press F12 in the browser, open Console, read
the first red line. `npm run verify:render` catches most of these before
anyone sees them.

---

## Rolling back

```powershell
cd C:\hms
Stop-Service hms
git checkout <previous-tag>
npm install
npm run build
Start-Service hms
```

This works as long as the upgrade did not drop or rename a database column. If
it did, restore the backup:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U hms -d hms -f "D:\hms-backups\before-upgrade-2026-09-18-1430.sql"
```

Tag every release so there is something to check out:

```powershell
git tag -a v1.1 -m "Lab report format and module toggles"
git push --tags
```

---

## Updating a client machine

Nothing to do. The browser fetches the new files automatically — Vite writes
them with a content hash in the name, so a new build means a new filename and
nothing is served from cache.

If a screen looks stale after an upgrade it is an old tab left open across the
restart. Ctrl+Shift+R.

---

## Turning modules on and off

Administration → Settings → **Modules in use**.

Switching a module off hides its sign-in cell and its buttons. It does not
delete anything, does not refuse an API call, and does not hide existing rows.
A hospital that starts with the main counter, laboratory and radiology can
switch the doctor terminal on in March and find its January data exactly where
it was.

This is a display decision, not a migration. That is the whole point of it.

---

## A word about updating during clinic hours

Don't, unless you have to. The upgrade takes seconds, but a cashier halfway
through a bill when the service stops loses that bill and has to start again.
Before the counter opens, or after it closes.
