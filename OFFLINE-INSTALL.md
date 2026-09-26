# Installing with no internet on site

Short answer: **do not copy `node_modules`, and do not plan to run `npm install`
there.** Build a self-contained bundle here, on the machine that has internet,
and carry that.

`node_modules` for this project is roughly 300 MB across 40,000 files. Copying
that to a USB stick and off again takes longer than everything else put
together, and Windows frequently fails partway through on the path lengths.

---

## What to do before you leave

On the machine that has internet, in the project folder:

```powershell
npm install
npm run bundle
```

That produces `hms-offline.zip`, around 13 MB. It contains:

- `dist/` — the built server and the built client
- `drizzle/` — the migrations, which the server applies on first start
- `node_modules/` — **only the packages the built server actually needs at
  runtime**, which is a small fraction of the full tree
- `scripts/` — the seed and setup scripts
- `package.json` and `START.bat`

The client needs nothing at runtime: it is already compiled into plain
JavaScript and CSS inside `dist/client`, and the server serves it.

---

## On the hospital machine

1. Install Node.js and PostgreSQL from the installers you have brought.
2. Create the database:

   ```powershell
   & "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres hms
   ```

3. Unzip `hms-offline.zip` to `C:\hms`.
4. Create `C:\hms\.env`:

   ```
   DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/hms
   PORT=4000
   ```

5. Double-click `START.bat`, or:

   ```powershell
   cd C:\hms
   node dist/server/index.js
   ```

The server applies all 17 migrations on first start, which brings the salt
catalogue, the company list and the laboratory and radiology tests with it.
Open `http://localhost:4000` and it will ask you to create the first
administrator account.

6. Once it works, install it as a service with NSSM as described in
   `DEPLOY-WINDOWS.md`, so it starts with the machine.

---

## Why not just copy the whole folder

You can, and it will work. It is simply slow and fragile:

| | Full folder | `npm run bundle` |
|---|---|---|
| Size | ~320 MB | ~13 MB zipped, 54 MB unpacked |
| Files | ~40,000 | ~4,900 |
| Copy to USB | 10–25 minutes | seconds |
| Fails on long Windows paths | sometimes | no |

If the bundle gives you any trouble on the day, copying the whole folder is a
perfectly good fallback. Take both on the stick.

---

## Take these as well

- The Node.js and PostgreSQL installers, matching the machine's architecture
- `nssm.exe`, for running it as a service
- A copy of this file and `DEPLOY-WINDOWS.md`
- A database dump from your own machine if you want the demo data to look at:
  `pg_dump -U hms hms > demo.sql`. **Do not load it into the hospital's
  database** — start them clean, or you will be deleting 800 fictional patients
  in front of the client.

## Check before you leave the office

Unzip the bundle into a folder on a machine that has never run this project,
point it at an empty database, and start it. If it serves the sign-in page and
asks you to create an administrator, the bundle is complete.
