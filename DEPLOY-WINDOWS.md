# Running it on Windows, permanently

For the hospital's machine. The goal is a system that comes back on its own
after a power cut, with nobody logged in and nobody watching.

**The method: run it as a Windows service using NSSM.** Not pm2. The reasoning
is in the last section if you want it, but briefly — pm2 has no reliable way of
starting before login on Windows, and a Windows service can be told to wait for
PostgreSQL, which is the single most common cause of a system that "works until
the power goes".

Steps 1 to 5 are the same as any install. Step 6 is the part that matters.

---

## 1. Node.js

Download the **LTS** installer from <https://nodejs.org>. Accept the defaults.

Open PowerShell and check:

```powershell
node --version
```

v20 or higher.

---

## 2. PostgreSQL

Download the EDB installer from
<https://www.postgresql.org/download/windows/>. Version 15, 16 or 17.

During installation:

- **Write down the password you set for `postgres`.** You need it in step 4 and
  it cannot be recovered. Losing it means reinstalling.
- Leave the port at **5432**.
- Untick Stack Builder at the end.

Confirm the service is running, and **note its exact name** — you need it in
step 6:

```powershell
Get-Service postgresql*
```

You will see something like `postgresql-x64-17`.

---

## 3. The application

Put it somewhere short and permanent. Not Desktop, not Downloads, not a folder
with your username in it.

```powershell
cd C:\
git clone https://github.com/Ali240-max/hms.git
cd C:\hms
npm install
```

---

## 4. Database

```powershell
npm run setup
```

Answer with the `postgres` password from step 2. Everything else can stay at
its default. This creates the database user, the database, the schema
permissions, and writes `.env`.

---

## 5. Build

```powershell
npm run build
```

Produces `dist\client` (what browsers load) and `dist\server\index.js` (one
bundled file). In production the server serves both, so there is **one process
and one port**. Vite is not involved.

Check it runs before making it a service:

```powershell
npm start
```

You want:

```
  Hospital server running
  This machine   http://localhost:4000
```

Open <http://localhost:4000>, confirm the sign-in page appears, then press
Ctrl+C. If this does not work, making it a service will not fix it.

---

## 6. Install it as a service

Download NSSM from <https://nssm.cc/download>. Take the **2.24-101** prerelease
rather than 2.24 — the release build is from 2014 and has trouble on modern
Windows. Unzip it and copy `win64\nssm.exe` to `C:\hms\nssm.exe`.

Open PowerShell **as Administrator**, then:

```powershell
cd C:\hms
mkdir logs -Force

.\nssm.exe install hms "C:\Program Files\nodejs\node.exe" "dist\server\index.js"

# The working directory. This is the one that gets people.
.\nssm.exe set hms AppDirectory C:\hms

# Wait for PostgreSQL. Without this the service loses the race after a power
# cut, fails to reach the database, and stays down until someone notices.
.\nssm.exe set hms DependOnService postgresql-x64-17

# Start after the rest of Windows has settled.
.\nssm.exe set hms Start SERVICE_DELAYED_AUTO_START

# Restart if it dies, but pause first so a broken config cannot spin.
.\nssm.exe set hms AppExit Default Restart
.\nssm.exe set hms AppRestartDelay 5000

# Logs, capped so they cannot fill the disk.
.\nssm.exe set hms AppStdout C:\hms\logs\out.log
.\nssm.exe set hms AppStderr C:\hms\logs\err.log
.\nssm.exe set hms AppRotateFiles 1
.\nssm.exe set hms AppRotateBytes 10485760

.\nssm.exe set hms Description "Hospital management system"

.\nssm.exe start hms
```

Replace `postgresql-x64-17` with whatever step 2 showed.

### Why `AppDirectory` is not optional

A Windows service starts in `C:\Windows\System32` unless told otherwise. This
server reads `.env`, serves the browser files, and writes backups all relative
to its working directory. Get it wrong and the service starts, looks healthy in
the Services list, and fails like this:

```
  Cannot reach the database.
    Tried: postgres://postgres:***@localhost:5432/hms
```

It never read your `.env` at all, so it fell back to defaults. The message
points at PostgreSQL and the real cause is the working directory. Set
`AppDirectory` and it cannot happen.

### Check it

```powershell
Get-Service hms
Invoke-WebRequest http://localhost:4000/api/auth/status | Select-Object -Expand Content
```

Expect `{"needsSetup":true,"user":null}` on a fresh database.

**Now test the thing you actually care about.** Reboot the machine, log in to
nothing, and from another PC open `http://<server-ip>:4000`. If that works, the
power-cut case works.

---

## 7. Reach it from other machines

```powershell
ipconfig
```

Note the **IPv4 Address**, e.g. `192.168.1.50`.

Open the firewall, private networks only:

```powershell
New-NetFirewallRule -DisplayName "Hospital system" -Direction Inbound `
  -Protocol TCP -LocalPort 4000 -Profile Private -Action Allow
```

Other machines use `http://192.168.1.50:4000`.

**Give the server a static IP.** The cleanest way is a DHCP reservation in the
router against the server's MAC address — the server then needs no
configuration and cannot be broken by someone changing it. Without this, a
lease change on a Monday morning breaks every machine in the building at once.

---

## 8. Demo data

```powershell
npm run seed
```

**Wipes everything.** Demo machines only, never the hospital's live system.

---

## Day-to-day

| Task | Command (as Administrator) |
|---|---|
| Status | `Get-Service hms` |
| Start / stop | `Start-Service hms` / `Stop-Service hms` |
| Restart | `Restart-Service hms` |
| Recent log | `Get-Content C:\hms\logs\out.log -Tail 50` |
| Follow the log | `Get-Content C:\hms\logs\err.log -Wait` |
| Edit settings | `.\nssm.exe edit hms` |
| Remove it | `.\nssm.exe remove hms confirm` |

## Deploying an update

```powershell
cd C:\hms
Stop-Service hms
git pull
npm install          # only if dependencies changed
npm run build
Start-Service hms
```

Database migrations run automatically on start; there is no separate step. Take
a backup first — Settings → Backups → Back up now, as an admin.

---

## Backups

The server writes one every 12 hours, keeps the last 14, and catches up on
start if the machine was off when one was due.

Put them on a different drive from the database:

```powershell
mkdir D:\hms-backups -Force
Add-Content C:\hms\.env "`nBACKUP_DIR=D:\hms-backups"
Restart-Service hms
```

Then get them off the machine entirely. A backup on the same computer as the
database is not a backup — one dead disk, one theft, one ransomware infection
takes both. A weekly copy to a USB drive or another PC:

```powershell
robocopy D:\hms-backups E:\hms-backups /MIR /R:1
```

Put that in Task Scheduler, weekly. It is the highest-value five minutes in
this whole document.

---

## When it will not start

Read the log first:

```powershell
Get-Content C:\hms\logs\err.log -Tail 40
```

The server prints a specific message for each common failure rather than a
stack trace.

**"Cannot reach the database"** — either PostgreSQL is not running
(`Get-Service postgresql*`), or `AppDirectory` is wrong so `.env` was never
read. Check the connection string in the error: if it says
`postgres://postgres:***@localhost:5432/hms` when your `.env` says something
else, it is the working directory.

**"The database refused those credentials"** — the password in `.env` is wrong.
Re-run `npm run setup`.

**"The server is there but the database does not exist"** — run
`npm run setup`.

**Service starts then stops immediately** — almost always a missing
`dist\server\index.js`. Run `npm run build`.

**Reachable on the server but not from other machines** — firewall rule missing,
or the machines are on different subnets. Test with
`Test-NetConnection <server-ip> -Port 4000` from a client.

**Forgotten admin password**

```powershell
cd C:\hms
npm run reset-password
```

---

## Checks worth running before you hand it over

```powershell
npm run typecheck
npm run verify:render
npm run verify:lan
npm run verify:roles
npm run verify:i18n
```

None need a database.

---

## Why NSSM rather than pm2

pm2 is the right tool on Linux and the wrong one here.

- **Starting before login.** A hospital PC reboots after a power cut and nobody
  logs in. pm2's Windows startup helpers are third-party and unreliable; a
  Windows service starts at boot by design.
- **Waiting for PostgreSQL.** `DependOnService` makes Windows start the
  database first and is the difference between recovering from a power cut
  automatically and someone driving in to press a button. pm2 has no equivalent.
- **Recovery.** A service is managed by the same Services console the hospital's
  IT person already knows, rather than a command-line tool they have never seen.

If you would rather keep one habit across both platforms, pm2 does work — install
it and `pm2-windows-startup` — but test the reboot case honestly before relying
on it.

---

## A caveat worth stating

The application is tested. The Windows service commands in step 6 are written
from the NSSM documentation and standard practice, not run on a Windows machine
by me, so treat the first install as something to verify rather than trust:
install it, reboot the machine, and confirm from another PC that it came back
before you leave the building.

The one thing I am confident about is `AppDirectory`, because I reproduced that
exact failure and its exact error message while writing this.
