# Running it on a Linux server with pm2

For a machine that stays on. Written against Linux Mint / Ubuntu; anything
Debian-based is the same.

The differences from the Windows guide are all in step 2. PostgreSQL on Linux
starts out with **peer authentication**, which means the `postgres` user has no
password and can only be reached by `sudo`-ing to it. That is why `npm run
setup` cannot connect until you give it one.

---

## 1. Node.js

Mint's repository ships an old Node. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version          # want v20 or higher
```

---

## 2. PostgreSQL

```bash
sudo apt install -y postgresql
sudo systemctl enable --now postgresql
sudo systemctl status postgresql      # should say active (running)
```

Now give the `postgres` role a password, because the setup script connects over
TCP like the application does:

```bash
sudo -u postgres psql -c "ALTER ROLE postgres WITH PASSWORD 'choose-a-password';"
```

<details>
<summary>Or skip that and create everything by hand</summary>

```bash
sudo -u postgres psql
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

Then write `.env` yourself and skip step 4:

```
DATABASE_URL=postgres://hms:hms@localhost:5432/hms
PORT=4000
```

The two lines about `public` matter on PostgreSQL 15 and later, where that
schema is no longer writable by everyone. Without them the first migration
fails with a permissions error that explains nothing.

</details>

---

## 3. The application

```bash
cd ~
git clone https://github.com/Ali240-max/hms.git
cd hms
npm install
```

---

## 4. Database and configuration

```bash
npm run setup
```

Answer with the password you set in step 2. Everything else can stay at its
default. It creates the role, the database, the schema permissions, and writes
`.env`.

---

## 5. Build

```bash
npm run build
```

This does two things: bundles the browser client into `dist/client`, and
bundles the server into a single `dist/server/index.js`. In production the
server serves both, so there is **one process and one port** — no Vite.

---

## 6. pm2

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup` prints a `sudo env PATH=...` command. Copy it, run it, then run
`pm2 save` again. That is what brings the system back after a power cut, which
is the whole reason for using pm2 here rather than `npm start` in a terminal.

Check it:

```bash
pm2 status
pm2 logs hms --lines 50
curl -s localhost:4000/api/auth/status
```

You want `{"needsSetup":true,"user":null}` on a fresh database.

---

## 7. Reach it from other machines

```bash
hostname -I          # e.g. 192.168.1.50
```

Other machines use `http://192.168.1.50:4000`. If the firewall is on:

```bash
sudo ufw allow 4000/tcp
```

Give the server a **static IP**, or a DHCP lease change on Monday morning
breaks every machine in the building. Do it in the router by reserving the MAC
address — that way the server needs no configuration.

---

## 8. Demo data

```bash
pm2 stop hms
npm run seed
pm2 start hms
```

**This wipes the database.** Fine on your test box, never on a hospital's.

---

## Day-to-day

| Task | Command |
|---|---|
| Status | `pm2 status` |
| Logs, live | `pm2 logs hms` |
| Restart | `pm2 restart hms` |
| Stop | `pm2 stop hms` |
| Resource use | `pm2 monit` |

## Deploying an update

```bash
cd ~/hms
git pull
npm install          # only if dependencies changed
npm run build
pm2 restart hms
```

Migrations run automatically when the server starts, so there is no separate
step. Take a backup first — see below.

---

## Backups

The server writes one every 12 hours and keeps the last 14. Point them off the
system disk:

```bash
sudo mkdir -p /var/backups/hms
sudo chown $USER /var/backups/hms
echo 'BACKUP_DIR=/var/backups/hms' >> .env
pm2 restart hms
```

To take one immediately, sign in as an admin and use Settings → Backups → Back
up now.

Getting them off the machine matters more than taking them. A backup on the
same disk as the database is not a backup — one dead disk loses both. On a
box that is already running 24/7, a weekly copy to another machine is one line:

```bash
rsync -a /var/backups/hms/ user@other-machine:/backups/hms/
```

---

## Differences to expect at the hospital's Windows box

Most of this transfers. What does not:

- **Installing PostgreSQL** uses the EDB installer and asks for the `postgres`
  password during setup, so step 2's `ALTER ROLE` is unnecessary there.
- **pm2 does not survive reboot on Windows** the way `pm2 startup` manages on
  Linux. Use `pm2-windows-startup`, or run the server as a Windows service with
  NSSM, which is the more reliable of the two.
- **Paths** in `BACKUP_DIR` use backslashes: `D:\hms-backups`.
- **The firewall** prompts on first run instead of needing `ufw`. Tick
  **Private networks** only.

Everything else — the build, the database, the migrations, the URLs — behaves
identically.

---

## If it will not start

```bash
pm2 logs hms --lines 100
```

The server prints a specific message for the common failures rather than a
stack trace: database unreachable, database missing, credentials rejected. Each
one names what to check.

If pm2 shows the process restarting over and over, it is crash-looping. The
config gives up after 10 attempts so it cannot fill the disk with logs; read
the first error, not the last.
