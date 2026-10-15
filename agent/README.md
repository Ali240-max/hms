# HMS attendance agent

One executable, two kinds of device. Which one is set by `Mode` in
`agent.ini`.

| | `Mode=reader` | `Mode=terminal` |
|---|---|---|
| The device | ZKTeco **Live20R / SLK20R / ZK9500** on this PC's USB | ZKTeco **K50** and family, on the network |
| Who holds the fingerprints | HMS | the device |
| Who does the matching | this agent | the device |
| Where staff are enrolled | the HMS screen | **on the device** |
| Needs the ZKFinger SDK | yes | **no** |
| Needs a DLL beside the exe | yes | **no** |
| How HMS knows who punched | it matched them | the device's user id, mapped |

The two are not the same thing in different shapes. A reader is a piece of
glass with no brain: this PC does the thinking. A terminal is a complete
computer on the wall that has already decided who the person is by the time
it tells anybody. So terminal mode does not match anybody and does not want
your templates — it reads the log of decisions the device already made and
forwards them.

Everything downstream is shared: the same queue, the same retry, the same
route into HMS, the same rows in the attendance table. A hospital can run a
reader at one door and a terminal at another and the reports will not know
the difference.

---

## Terminal mode (a K50 on the network)

Start here if you have a terminal rather than a USB reader. There is less to
do, because the device already knows everybody.

### 1. Build it

```
build.bat
```

No SDK, no driver, no DLL. The protocol is spoken over a socket.

### 2. Add the device in HMS

Administration → Attendance → Devices → **Add a device**, and choose
**Terminal on the network**. Copy the key it shows you once.

### 3. Fill in agent.ini

```
Server=http://192.168.1.84:4000
DeviceKey=<the key HMS showed you>
Mode=terminal
DeviceIp=192.168.1.201
DevicePassword=0
```

`DeviceIp` is the address on the device under **Menu → Comm → Ethernet**.
`DevicePassword` is its comm key, under **Menu → Comm → Security → Comm
Key** — `0` means none, which is how they ship.

### 4. Check it before trusting it

```
hms-attendance-agent.exe --probe
```

This connects, reads the clock, counts what is on the device, lists everybody
enrolled with who they map to in HMS, and shows the last ten punches. **It
posts nothing and changes nothing on the device.** Run this first, every
time, on a new install.

A clean probe looks like this:

```
  connected
  device clock  2026-10-10 12:31:04   (this PC is 0 min different)
  users 14, fingers 21, records 3180 of 100000

  ON THE DEVICE            MAPS TO IN HMS
  id 1       Imran Bhatti    staff 1  Imran Bhatti
  id 7       Saleem Akhtar   -- NOBODY --

  3180 punch(es) on the device, last 10:
    2026-10-10 09:14:33  id 1       -> staff 1      (40-byte record)
```

`-- NOBODY --` is the thing to fix: that person's punches will be counted and
refused, not guessed at. See **Mapping** below.

### 5. Map the people

**An unmapped device id is dropped, not guessed at.** Put each person's
device id against them in HMS: **Administration → Staff → Edit → "Id on the
attendance terminal"**. The probe output above is the list to work from — it
prints the device's own name beside the HMS name so you can see at a glance
whether a pairing is right.

A punch from an unmapped id is counted, named in the log, and discarded.
Nothing is lost by it: the device keeps its own log, so the moment you set the
id the punch is picked up on the next poll.

**Why it is not guessed.** The obvious shortcut is to read device user 7 as
HMS staff 7, and that is right *only* when the device was numbered to match
HMS. On a terminal that was already in service the numbers mean something
else, and the first probe against a real K50 made that vivid:

```
  id 1       Yasir               staff 1  Administrator
  id 2       Farhan              staff 2  Sana Tariq
  id 3       Sana                staff 3  Hina Butt
```

Nineteen pairings, every one wrong, every one looking perfectly ordinary. The
two failures are not equally bad: an unmapped id is a **gap** — visible,
counted, fixable in a minute — while a wrong guess is one person's attendance
filed under another's name, which nobody ever finds.

If you *did* enrol the device to match HMS, `TrustDeviceIds=true` in
`agent.ini` turns the shortcut back on. Run `--probe` first and read the two
name columns; the probe marks any pairing of two different names with
`<<< DIFFERENT PERSON`.

### 5b. Or create people on the device from HMS

Instead of typing somebody into the K50's menus and then their id into HMS,
open **Administration → Staff → Edit** for them and press **Create on the
terminal**. The agent picks the request up within a few seconds (`JobSeconds`,
default 5), creates the user on the device over the connection it already
uses, reads the user list back, and only then reports **done**. Their terminal
id is filled in for you.

- **The id** is the one in their "Id on the attendance terminal" field, or
  their HMS staff id if that is blank. Digits only, up to nine.
- **A user already on the device under that id is never touched.** If HMS
  does not already map this person to that id, it is reported as a conflict
  with the name the device holds, and a person decides: set the mapping if it
  is the same person, or choose another id.
- **New users get ordinary privilege, no password and no card.** HMS holds
  none of those.
- **Pressing it twice, or the agent retrying, does not create a second user.**
- **No fingerprints are sent.** Once the user exists, enrol their finger on
  the K50 itself: Menu → User Mgt → find the id → Edit → Fingerprint.

The request goes through the agent, so the agent must be running in terminal
mode. If it is not, the screen says when it was last heard from.

### 6. Run it

```
hms-attendance-agent.exe
```

It polls every twenty seconds. The device holds its own log, so nothing is
lost if this PC is off, the network drops, or HMS is down — it catches up on
the next poll.

### What it will not do

**It never clears the device log.** The protocol has a command for it and
this agent does not send it. Clearing is the easy way to avoid reading the
same record twice and it is the wrong way: the moment HMS is unreachable, or
the mapping is wrong, the only copy of a day's attendance would be gone. A
high-water mark in `last-punch.txt` beside the exe does that job instead.

**It does not push fingerprints to the device.** Enrol on the device. HMS
enrolment is for readers. Whether a template taken on a USB reader is one the
K50 will accept has not been shown on this hardware, and a wrong one would
leave somebody who "has a finger" and is never recognised.

**It never deletes a user on the device or writes over one.** It only adds
users who are not there, and checks first.

### The device's clock is the one that matters

Every record a terminal hands over is stamped by **its own clock**, not the
server's. A device whose battery died and came back at midnight on the first
of January will hand over a month of attendance dated in the year 2000, and
HMS will store it exactly as given, because there is no way to tell from the
outside.

The agent warns on every poll when the two clocks are more than two minutes
apart. To fix it:

```
hms-attendance-agent.exe --probe --set-time
```

### First run on a device with history

A terminal that has been in service for a year hands over a year of
attendance the first time it is read. `BackfillDays=14` in `agent.ini` is
what stops all of it being posted and rewriting every absentee report for
those months. Set it to `0` for a deliberate back-fill.

### If the probe fails

In this order:

1. `ping 192.168.1.201`
2. the device and this PC are on the same subnet
3. **Menu → Comm → Ethernet** on the device shows that address
4. **ZKBio Time, or any other software, is closed** — some firmware allows
   only one connection at a time, and this is the most common cause
5. `DevicePassword` matches **Comm → Security → Comm Key**

### Checking the protocol itself

```
test-protocol.bat
```

Touches no real device. It checks the arithmetic against values from the
reference implementation, pins the connect packet byte for byte, and then
stands up a **fake terminal on loopback** and holds a whole conversation with
it — connect, authorise, clock, counters, user list, attendance log, twice
over.

That last part exists because of a real fault. A chunked read is answered with
three packets and the agent read two; the leftover became the next command's
answer, and from then on every reply belonged to the command before it. The
user list still worked, because it came first. The attendance read got the
previous command's empty acknowledgement and reported that the device had
refused — which was false in every particular, and the symptom was two
commands away from the cause.

No amount of arithmetic testing finds that. It needs something on the other
end of a socket.

---

## Reader mode

## What you need on that PC

1. **ZKFinger SDK 5.x driver**, from ZKTeco. Install it *before* plugging the
   reader in. This is what puts `libzkfp.dll` and `libzkfpcsharp.dll` on the
   machine.
2. Windows 10 or 11. Nothing else — no Visual Studio, no .NET SDK, no
   internet. The agent builds with the compiler already inside Windows.

---

## Build it

```
build.bat
```

That is all. It produces `hms-attendance-agent.exe`.

**It builds for x86 deliberately.** The ZKFinger DLLs are 32-bit, and a
64-bit process cannot load them — it fails with `BadImageFormatException`,
which reads like a corrupt file rather than the architecture mismatch it is.
Do not "fix" the build by removing `/platform:x86`.

---

## Set it up

**1. Copy the wrapper next to the exe.**

```
copy C:\Windows\SysWOW64\libzkfpcsharp.dll .
```

If it is not there, look in `C:\Windows\System32`. The agent will also find it
in either of those places on its own, but copying it next to the exe is what
survives a driver reinstall moving things around.

**2. Add the reader in HMS.**

Administration → Attendance → Readers → Add a reader. The key is shown
**once**, when you create it. Copy it.

**3. Run the agent once.**

```
hms-attendance-agent.exe
```

It writes `agent.ini` and stops, telling you what to fill in. Open it and set:

```ini
Server=http://192.168.1.84:4000
DeviceKey=<the key from step 2>
DeviceName=Staff entrance
```

**4. Run it again.** It should say:

```
readers found: 1
templates loaded: 0
enrolment api on http://127.0.0.1:5577
ready — place a finger on the reader
```

---

## Enrol some fingers

At that same PC, open HMS and go to **Administration → Attendance →
Fingerprints**. Pick somebody, press **Fingers**, choose a finger, press
**Enrol this finger**, and press the same finger on the reader three times.

Enrolment only works at the PC the reader is plugged into — a browser cannot
touch USB. The screen says so when the agent is not there.

**Lift the finger completely between the three presses.** The agent will not
take the next press until the glass has been empty for a moment. Earlier
builds did not wait: a finger held on the glass gave all three "presses" from
one placement, which made a template that only recognised that one placement
— and a person who then had to press five or six times at the door before
they happened to put the finger down the same way.

**Re-enrol everybody enrolled before this build.** Their templates were made
the old way and are the most likely cause of slow recognition. Enrolling the
same finger again replaces the old template.

**Enrol two fingers per person.** Hospital hands get cut, bandaged and gloved,
and one enrolled thumb is one bad morning away from somebody standing at a
door unable to clock in.

---

## Run it as a service

So it survives a reboot with nobody logged in. Using NSSM, same as the HMS
server:

```
nssm install hms-attendance "C:\hms-agent\hms-attendance-agent.exe"
nssm set hms-attendance AppDirectory "C:\hms-agent"
nssm set hms-attendance Start SERVICE_AUTO_START
nssm start hms-attendance
```

Running by hand instead? Windows refuses the enrolment listener to a
non-administrator. Once, from an administrator prompt:

```
netsh http add urlacl url=http://127.0.0.1:5577/ user=Everyone
```

As a service this never comes up, because it runs as LocalSystem.

---

## How it behaves

**Templates live in memory only.** The SDK forgets every template when the
process stops, so the agent reloads them from HMS at startup and every five
minutes. Somebody enrolled on another PC is recognised here within five
minutes without anybody restarting anything.

**One press is one punch.** The reader fires continuously while a finger
rests on the glass. After a press has been decided — matched or not — the
agent does nothing more until the finger is lifted. The same finger again
within five seconds is not posted, and the server independently refuses
repeats within five minutes.

**A press is tried up to three times before "not recognised".** The first
frame of a press is often the finger still landing. Each try is a full match
at the SDK's own threshold; nothing is accepted without one. A failed press
lights the reader red (if the SDK build supports it; `Feedback=false` turns
the lights and beep off) and, when the door screen runs on the same PC, shows
"Not recognised" there.

**A template reload no longer empties the matcher mid-scan.** Reloading and
identifying share one lock, and a reload that brings back the same list is
skipped.

**Scans alternate.** The server reads a day's scans in time order: first a
check-in, second a check-out, third a check-in again. A press that was not
recognised never reaches the server, so it does not count.

**Punches survive everything.** They are written to `queue.txt` before being
sent and removed only after the server confirms. Pull the network cable, kill
the process, reboot the PC — the punches go when the server comes back. A
punch that arrives twice is invisible; a punch that never arrives is somebody
marked absent.

**The server refusing is final, the network failing is not.** A 4xx is the
server's considered answer — an exempt person, a staff member since deleted —
and the punch is dropped. A 5xx or a dead connection waits and retries.

**It cannot enrol anybody.** The reader key is only good for reading templates
and writing punches. Deciding whose finger a template belongs to needs an
administrator signed in, so a key sitting in a text file on a PC by a door
can never add a finger to somebody's record.

---

## When it goes wrong

Everything lands in `agent-YYYY-MM-DD.log` beside the exe, and on screen.

| It says | What to do |
|---|---|
| `libzkfpcsharp.dll not found` | Install the ZKFinger SDK 5.x driver, then copy the DLL next to the exe |
| `wrong architecture for this process` | You built 64-bit. Use `build.bat` |
| `no reader is plugged in` | Check the USB cable and the driver in Device Manager |
| `the reader would not start` | Something else has it open — ZKTeco's own attendance software holds the device exclusively. Close it |
| `zkfp2.X not found` | Older SDK installed. Install 5.x |
| `templates loaded: 0` | Nobody has enrolled yet, or the reader key is wrong |
| `cannot reach the server` | Check `Server=` in agent.ini and that the HMS server is up |
| `not recognised after 3 tries on one press` | That person is not enrolled, or was enrolled before the lift-between-presses fix — re-enrol them. Otherwise press flatter and firmer |
| `this SDK build has no SetParameters` | Harmless: the reader will not light or beep, everything else works |
| `jobs: could not reach the terminal` (terminal mode) | Same checks as a failed `--probe`; the HMS screen shows the same message |
| `job N: user X ALREADY_PRESENT` and HMS says conflict | Somebody is already on the device under that id. Check who, then map or choose another id |

---

## What is not tested

I wrote this without the device in hand. The HTTP half is covered end to end
by `npm run verify:agent` on the server side — every header, body and status
code the agent depends on, including the retry and refusal paths.

The twenty or so lines that call the SDK are not, and cannot be, until a
reader is plugged into something. Those are: `Init`, `OpenDevice`, `DBInit`,
`AcquireFingerprint`, `DBIdentify`, `DBMerge`, `DBAdd`.

Expect the first run to need a round of fixing. The log is written to be
useful for exactly that.
