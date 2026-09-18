# Setting up the hospital system

Written for a fresh Windows machine. Takes about twenty minutes, most of it
waiting for installers.

There are two pieces: **PostgreSQL**, which stores the data, and **this
application**, which talks to it. PostgreSQL does not come with the app and has
to be installed separately. That is the step that catches people out — the app
cannot create its own database server, only its own database inside one.

---

## 1. Install Node.js

Download the **LTS** version from <https://nodejs.org>. Accept every default.

Check it worked. Open PowerShell and run:

```powershell
node --version
```

You want v20 or higher.

---

## 2. Install PostgreSQL

Download from <https://www.postgresql.org/download/windows/> — the EDB
installer. Version 15, 16 or 17 all work.

During installation:

- **Write down the password you set for the `postgres` user.** You need it in
  step 4 and there is no way to recover it later. If you lose it the fastest
  fix is to uninstall and reinstall.
- Leave the port as **5432**.
- Stack Builder at the end is not needed. Untick it.

Check it is running: press Win+R, type `services.msc`, look for
**postgresql-x64-17** (or your version). It should say **Running**.

---

## 3. Get the application

```powershell
cd C:\
git clone https://github.com/Ali240-max/hms.git
cd hms
npm install
```

`npm install` takes a few minutes.

---

## 4. Create the database

```powershell
npm run setup
```

It asks a handful of questions. Press Enter to accept the default for all of
them except the `postgres` password from step 2.

```
  PostgreSQL host [localhost]:
  PostgreSQL port [5432]:
  Admin username (set when you installed PostgreSQL) [postgres]:
  Password for postgres: ********
  Database name to create [hms]:
  Database user for this app [hms]:
  Password for that user [hms]:
  Port the hospital server should listen on [4000]:
```

This creates the database user, the database itself, sets the permissions, and
writes a `.env` file with the connection details. It is safe to run twice — it
never drops anything.

The tables are created automatically the first time the server starts, so there
is nothing else to do.

<details>
<summary>Doing it by hand instead</summary>

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres
```

```sql
CREATE ROLE hms WITH LOGIN PASSWORD 'hms';
CREATE DATABASE hms OWNER hms;
GRANT ALL PRIVILEGES ON DATABASE hms TO hms;
\c hms
GRANT ALL ON SCHEMA public TO hms;
ALTER SCHEMA public OWNER TO hms;
\q
```

Then create `.env` in the project folder:

```
DATABASE_URL=postgres://hms:hms@localhost:5432/hms
PORT=4000
```

The last two SQL lines matter on PostgreSQL 15 and later, where the `public`
schema is no longer writable by everyone. Without them the first migration
fails with a permissions error that does not explain itself.

</details>

---

## 5. Start it

```powershell
npm run dev
```

Two things start together. Wait for both:

```
[server]   Hospital server running
[client]   ➜  Local:   http://localhost:5173/
```

Open <http://localhost:5173> and create the first admin account. There is no
default password; the first account you make is the administrator.

---

## 6. Demo data, for showing the system

```powershell
npm run seed
```

**This wipes everything and replaces it with invented patients.** Only ever run
it on a demo machine, never on a hospital's live system.

It creates around 800 patients across 45 days of history plus 60 days of future
bookings, so every screen and chart has something in it. Logins:

| Login | Password | Screen |
|---|---|---|
| `admin` | `admin-demo-1` | Administration |
| `main-counter` | `1234` | Registration, fees, chit payments |
| `opd` | `1234` | Queue and vitals |
| `emergency` | `1234` | Emergency admissions |
| `dr.yasir` | `1234` | Doctor |
| `pharmacy` | `1234` | Pharmacy till |

Other doctors: `dr.sana`, `dr.imran`, `dr.ayesha`, `dr.kamran`, all `1234`.

---

## 7. Other machines on the network

Find the server's address:

```powershell
ipconfig
```

Look for **IPv4 Address**, something like `192.168.1.50`.

**For a demo with `npm run dev`**, other machines use port 5173:
`http://192.168.1.50:5173`. You also need to start it with `npm run dev -- --host`
so Vite listens on the network rather than only on the server itself.

**For real use**, build it once and run the server alone — one port, no Vite:

```powershell
npm run build
npm start
```

Then every machine uses `http://192.168.1.50:4000`.

You will likely need to let it through the firewall the first time. Windows
will ask; tick **Private networks**.

---

## Tomorrow's demo — the short version

```powershell
npm run setup       # once
npm run seed        # demo data
npm run dev         # leave this running
```

Open <http://localhost:5173>, sign in as `main-counter` / `1234`.

A walkthrough that shows the whole system in about five minutes:

1. **Main counter** — register a patient, pick a doctor, take the fee. Point
   out they are not in anyone's queue until the bill completes.
2. **OPD counter** — the patient has appeared. Record a blood pressure, send
   them in.
3. **Doctor** — they are now in *Ready for you* with the reading already there.
   Prescribe a medicine and order an X-ray.
4. **Main counter** — the X-ray chit appeared on its own. Take payment, print
   the chit. It says PAID with a signature box for the department.
5. **Pharmacy** — the prescription is waiting. Fill it, take payment, print the
   receipt and the dosage labels.
6. **Emergency** — admit a walk-in, add a bedside medicine, show that it lands
   at the pharmacy and the fee lands at the main counter.
7. **Bottom right** — switch to Urdu, switch to dark mode.

---

## When something goes wrong

**`ECONNREFUSED` on `/api/...` in the client**

Vite is proxying to the wrong address. In `vite.config.ts` the target must be
`http://127.0.0.1:4000`, never `http://localhost:4000`. On Windows `localhost`
resolves to IPv6 `::1` first, the server listens on IPv4, and every call fails.

**"Cannot reach the database"**

PostgreSQL is not running. `services.msc`, find `postgresql-x64-…`, start it.

**"The server is there but the database does not exist"**

Run `npm run setup`.

**"The database refused those credentials"**

The password in `.env` is wrong. Re-run `npm run setup`.

**A screen goes blank and white**

A crash in the browser. Press F12, open Console, and read the first red line.
Run `npm run verify:render` and `npm run verify:lan` — between them they catch
most causes.

**Forgotten admin password**

```powershell
npm run reset-password
```

Lists the accounts and lets you set a new password. Passwords are hashed and
cannot be read back, only replaced.

---

## Checks worth running before any deployment

```powershell
npm run typecheck        # both halves compile
npm run verify:render    # every screen renders in both languages
npm run verify:lan       # no browser APIs that break over plain HTTP
npm run verify:roles     # every role can sign in and be created
npm run verify:i18n      # no half-translated screens
```

None of these need a database. The rest — `verify:billing`, `verify:emergency`,
`verify:chits`, `verify:pharmacy`, `verify:screens` — need the server running
and demo data loaded.

**`verify-opd.ts` and `verify-api.ts` wipe the database they run against.**
Only ever point them at a scratch database.

---

## Backups

The server writes one every 12 hours to the `backups` folder, keeping the last
14, and catches up on startup if the machine was switched off when one was due.

Set `BACKUP_DIR` in `.env` to a second drive or a network folder. A backup
sitting on the same disk as the database is not a backup — one dead disk takes
both. Copying the folder to a USB stick weekly costs nothing and is worth more
than any other single thing on this page.

---

## Running it properly at a hospital

For a demo `npm run dev` is fine. For a system people depend on:

- Build it (`npm run build`) and run `npm start`. One process, one port.
- Put the server PC and the network switch on a **UPS**. Load shedding will
  otherwise cut power mid-write.
- Use **wired ethernet** for the server. Wi-Fi drops are indistinguishable from
  the system being down.
- Give the server PC a **static IP**, or every client breaks when it changes.
- Delete the demo accounts and create real ones with real passwords.
