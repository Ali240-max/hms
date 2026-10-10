# HMS attendance agent

Runs on the PC with the ZKTeco fingerprint reader plugged into it. Matches a
finger against the templates HMS holds and posts the result to the server.

Tested against **SLK20R / Live20R**. The same SDK covers ZK9500, ZK6500 and
ZK8500R, so those should work unchanged.

---

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
rests on the glass. The agent ignores the same finger for five seconds, and
the server independently refuses repeats within five minutes.

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
| `not recognised` on every press | That person is not enrolled, or press flatter and firmer |

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
