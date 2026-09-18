# Hospital OPD

Patient registers, sees a doctor, gets a prescription, collects it at the
pharmacy. One Postgres database, one server, browsers everywhere else.

## Running it

**PostgreSQL must be installed and running first.** This is a server product;
unlike the standalone pharmacy till it does not carry its own database engine.

On Windows: install PostgreSQL from https://www.postgresql.org/download/windows/,
remember the password you set for the `postgres` user, then create the database:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres hms
```

Then:

```bash
npm install
copy .env.example .env        # put your real password in DATABASE_URL
npm run dev                   # server on :4000, client on :5173
```

If the server cannot reach the database it now says exactly which of those
three things is wrong rather than printing a stack trace.

For real use:

```bash
npm run build
npm start                     # serves the API and the client on :4000
```

Other machines open `http://<server-ip>:4000`. Nothing to install on them.

### Demo data

Either from the command line:

```bash
npm run seed -- --reset            # 45 days by default
npm run seed -- --reset --days 90
```

Or, once signed in as admin, from **Administration → Demo data**. Same
generator either way.

It creates around 550 patients across 45 days of visits, five doctors on
different fee and share arrangements, five departments, twenty services and a
stocked pharmacy — and deliberately leaves a few patients still waiting in
today's queue so the reception and doctor screens have something live in them.

Replacing existing data needs a typed confirmation, and signs you out because
staff accounts are recreated.

## The four roles

| | Admin | Reception | Doctor | Pharmacy |
|---|---|---|---|---|
| Register patients, manage the queue | yes | yes | | |
| Prescribe, order tests | yes | | yes | |
| See prescriptions and stock | yes | | | yes |
| Staff, services, prices, shares | yes | | | |
| Every doctor's earnings | yes | | own only | |

The department buttons on the login screen choose a starting point, not a
permission. What someone can do comes from the role on their account and is
checked on the server. If the buttons granted access, anyone could click
Administration.

**There is no default password.** First run asks for an admin account.

## Decisions worth knowing

**Doctors prescribe from a catalogue, not from stock.** A drug is prescribed
because it is clinically right, not because there are 40 strips on the shelf.
Stock shows as an advisory badge and anything not stocked can still be written
as free text. A system that quietly narrows treatment to what is in inventory
is a bad thing to have built.

**Prescribed and dispensed are separate numbers.** Patients here routinely buy
half a course. "Prescribed 20, dispensed 10" is a normal outcome, not an error.

**Prices and shares are snapshotted.** A service order stores the price and the
doctor's percentage as they were at that moment. Raising a price next month
does not rewrite what a doctor already earned. Tested.

**Earnings are a ledger, not a calculation.** The figure a doctor is paid
against can be reconstructed line by line months later. A unique index on
(source, ref_table, ref_id) is what stops a re-saved consultation paying twice.

**The prescribing doctor comes from the session.** Never from the request body.
A client-supplied doctor id is a signature anyone could forge, and it decides
who gets paid.

**Money is integer paisa, percentages are basis points.** No floats anywhere
near money. 20% is 2000.

**Patient identity is the real risk.** Not the code, the data. The same person
returns months later with a slightly different name and no CNIC. Registration
searches on phone, name and CNIC and warns about likely duplicates, but never
blocks: twins, shared family phones and genuine namesakes all exist, so the
receptionist decides.

## What is not built yet

- **Pharmacy billing and stock deduction.** The pharmacy screen shows the
  prescription and live stock; it does not yet take a payment or move stock.
  The pharmacy tables are all in this database ready for it.
- Lab and radiology result entry. Orders are recorded and charged; results are
  not captured.
- Printing. No prescription slip or token slip yet.
- Admission, wards, IPD.

## Keeping it running

The pharmacy and OPD now depend on this server, so it needs treating as
clinical infrastructure rather than a spare PC:

- a UPS on the server **and** on the switch, or you have protected half a chain
- wired ethernet to the pharmacy, not wifi
- automatic Windows restarts turned off, and a static IP
- a paper fallback that staff know about, for the twenty minutes when something
  is down

## Tests

```bash
npx tsx verify-opd.ts     # identity, visits, prescriptions, earnings
npx tsx verify-api.ts     # the same over HTTP, plus role enforcement
```

`verify-api.ts` exists because service-level tests cannot see a missing route or
a permission that was only ever implemented in the client. Anything the browser
talks to is tested the way the browser arrives.
