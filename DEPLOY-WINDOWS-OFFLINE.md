# Installing on a Windows server with no internet

This is the whole job, in order. Read it once before you go.

Everything is done from the `hms-offline.zip` bundle, so there is no
`npm install` on site and no internet needed after the installers are run.

---

## Before you leave the office

On the machine that has internet:

```powershell
cd E:\Development\hms\hms
npm run bundle
```

`npm run bundle` now runs the build itself. It used to assume you had built
already, and that shipped a stale application: unzip a new version over the
repository, bundle without rebuilding, and `dist/` is still last week's. That
is how an old sign-in screen turned up on a laptop after an update. It will now
also refuse to package a build older than the source.

Check the stamp before you copy it anywhere:

```powershell
Expand-Archive hms-offline.zip -DestinationPath .\check -Force
Get-Content .\check\VERSION.txt
Remove-Item .\check -Recurse
```

`bundled` should be a minute ago. If it is not, something went wrong.

### Put on the USB stick

- `hms-offline.zip` (about 13 MB)
- Node.js LTS installer, the **x64 MSI**
- PostgreSQL installer, **17.x Windows x86-64**
- `nssm.exe` from nssm.cc, the **win64** one
- This file
- Optionally the whole repository folder as a fallback, minus `node_modules`

---

## On the hospital server

### 1. Node.js

Run the MSI, accept the defaults. Then check:

```powershell
node --version
```

Anything from v20 upwards is fine. If PowerShell says it is not recognised,
close and reopen it: the installer changes PATH and an open window keeps the
old one.

### 2. PostgreSQL

Run the installer. When it asks:

- **Password for `postgres`** — set one and write it down. You need it twice
  today and once every time you restore a backup.
- **Port** — 5432.
- **Locale** — default.
- Stack Builder at the end: **skip it**, it wants the internet.

Then create the database:

```powershell
cd "C:\Program Files\PostgreSQL\17\bin"
.\createdb.exe -U postgres hms
```

It will ask for the password you just set.

### 3. Unpack the application

```powershell
New-Item -ItemType Directory C:\hms -Force
Expand-Archive D:\hms-offline.zip -DestinationPath C:\hms -Force
Get-Content C:\hms\VERSION.txt
```

Confirm the date is the bundle you built. This is the last moment where
catching the wrong version is cheap.

### 4. Settings

Create `C:\hms\.env` with Notepad. **Save it as `.env`, with quotes around the
filename in the save dialog**, or Notepad will make it `.env.txt` and the
server will not find it.

```
DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/hms
PORT=4000
BACKUP_DIR=D:\hms-backups
```

If the password contains `@ : / ?` or `#`, percent-encode it: `p@ss` becomes
`p%40ss`.

### 5. First run, by hand

```powershell
cd C:\hms
node dist\server\index.js
```

You want to see the migrations apply and then:

```
Hospital server running
This machine   http://localhost:4000
Other machines http://<this-pc-ip>:4000
```

Open `http://localhost:4000`. It will ask you to **create the first
administrator**. That account can never be restricted later, so make it the
hospital's own, not a temporary one of yours.

Press Ctrl+C to stop it once you have seen the sign-in screen.

**If it will not start,** the message says which of these it is:

- *Cannot reach the database* — PostgreSQL is not running
  (`Get-Service postgresql*`), or the password in `.env` is wrong.
- *Nothing happens, no output* — you are in the wrong folder.
- *A wall of red* — read the first line only; the rest is the stack.

### 6. Install it as a service

So it starts with the machine and survives a power cut.

```powershell
Copy-Item D:\nssm.exe C:\hms\nssm.exe
cd C:\hms
.\nssm.exe install hms "C:\Program Files\nodejs\node.exe" "C:\hms\dist\server\index.js"
.\nssm.exe set hms AppDirectory C:\hms
.\nssm.exe set hms AppStdout C:\hms\logs\out.log
.\nssm.exe set hms AppStderr C:\hms\logs\err.log
.\nssm.exe set hms Start SERVICE_AUTO_START
.\nssm.exe set hms AppRestartDelay 5000
New-Item -ItemType Directory C:\hms\logs -Force
Start-Service hms
Get-Service hms
```

**`AppDirectory` is the line that matters.** Without it the service starts in
`C:\Windows\System32`, never finds `.env`, and fails with a database error
that looks nothing like the real cause.

Confirm:

```powershell
Invoke-WebRequest http://localhost:4000/api/health | Select-Object -Expand Content
```

### 7. Let the other machines in

```powershell
New-NetFirewallRule -DisplayName "HMS 4000" -Direction Inbound `
  -LocalPort 4000 -Protocol TCP -Action Allow -Profile Private,Domain
```

Find the server's address:

```powershell
ipconfig | Select-String IPv4
```

Then, from a counter PC, open `http://THAT-ADDRESS:4000`. If it does not load
but `localhost` does on the server, it is the firewall rule or the machines are
on different subnets.

**Give the server a fixed IP**, or a static DHCP reservation on the router. If
its address changes, every machine in the hospital loses the system at once and
nobody will know why.

### 8. Before you hand it over

- [ ] Sign in as the administrator you created
- [ ] Administration → Settings: hospital name, address, phone, logo
- [ ] Administration → Services: **set a price on every test they offer**.
      Unpriced tests are refused at the counter on purpose.
- [ ] Administration → Settings → Modules in use: switch off what they are not
      using yet
- [ ] Administration → Staff: create the real accounts, and for each
      administrator set what they may change under Access
- [ ] Administration → Settings → Backups: point the second copy at a
      different drive from the database
- [ ] Register one test patient, take a payment, print the chit
- [ ] Print a sticker sheet and check it against the die-cut paper
- [ ] Take a backup, and make sure you can find the file
- [ ] Reboot the server and confirm the service comes back on its own
- [ ] Delete the test patient: Administration → Settings → clear all data,
      **only if** nothing real has been entered yet

### 9. Leave behind

Written on paper, taped inside the server cabinet:

- The server's IP address and the URL staff use
- The `postgres` password
- Where the backups go
- Your phone number
- That the machine must not be switched off during clinic hours

---

## Upgrading later, still offline

Build a fresh bundle at the office, carry it over, then:

```powershell
# always first
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -U postgres hms > D:\before-upgrade.sql

Stop-Service hms
Remove-Item C:\hms\dist -Recurse -Force
Remove-Item C:\hms\node_modules -Recurse -Force
Expand-Archive D:\hms-offline.zip -DestinationPath C:\hms -Force
Get-Content C:\hms\VERSION.txt
Start-Service hms
```

`.env`, `logs\` and the database are untouched. Migrations apply on start.

Deleting `dist` and `node_modules` before unzipping matters: `Expand-Archive`
overwrites files but never removes ones that are no longer in the bundle, and a
file left behind from an older version is the hardest kind of bug to see.

---

## Thermal printers: stopping the blank roll

A thermal printer feeds paper to the end of the page its **driver** is set to.
The browser cannot override that: Chrome only offers the paper sizes the
driver exposes, so asking for a page 104mm long is ignored unless a form of
that size exists on the machine.

A driver left on its default of **80 x 3276 mm** therefore feeds over three
metres of blank roll after every receipt. That is not a fault in the software;
it is the printer doing exactly what it was told.

### Check what it is set to

Settings → Printers & scanners → your printer → Printing preferences → Paper
size. If it reads 3276mm or 99999mm, that is the problem.

### The quick fix, with some waste

Set the paper size to **80 x 210 mm**, and in the application set
**Printing → Page length → 210 mm** to match. A receipt of 100mm then wastes
110mm of roll. Acceptable, not ideal.

### The proper fix: a form the size of a receipt

Windows lets you define your own paper size, and the printer then feeds only
that much.

1. Open **Print Management**, or run `printui /s /t1` as an administrator.
2. On the **Forms** tab, tick **Create a new form**.
3. Name it `Receipt 80x120`.
4. Units: metric. Width **8.00 cm**, Height **12.00 cm**. Set all four margins
   to 0.
5. **Save Form**, then close.
6. Printing preferences for the printer → Paper size → choose `Receipt 80x120`.
7. In the application, Printing → Page length → the nearest value, or leave it
   on "As long as the receipt" now that a matching form exists.

Pick a height a little longer than your longest slip. A chit with several
tests runs longer than a consultation receipt; 120mm covers most, 150mm covers
almost all. Anything longer than the form is split across two pages, which is
worse than a little waste, so err on the generous side.

### Also worth setting

- **Auto cut: after each page**, in the driver. Without it the roll has to be
  torn by hand and the tear often takes the last line with it.
- In Chrome's print dialog, **Margins: None** and **Headers and footers: off**.
  Chrome remembers both per printer, so it is a one-off per machine. The
  headers are what put the date and "localhost:5173" on the first receipts.

### If you want no waste at all

The only way to have the printer stop exactly at the last line is to talk to
it directly in ESC/POS rather than through the browser's print system. That
means a small print agent running on the counter PC. It is a real improvement
for a busy counter and a day's work to build; ask when the trial is over and
you know how much roll this is actually costing.
