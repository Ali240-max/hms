# Receipt printers

Receipts are printed **by the server**, in ESC/POS, straight to the printer.
The browser is not involved.

That matters for one reason: **the printer has to be reachable from the
server.** A printer plugged into a counter PC by USB is not, until that PC
shares it.

## Why it changed

A browser prints *pages*. It asks Windows for a paper size, and a thermal
printer feeds to the end of whatever page its driver is set to. A driver left
on 80 x 3276mm fed over three metres of blank roll after every receipt, and no
amount of CSS could change it, because the page length was never the browser's
to choose.

ESC/POS has no pages. The server sends text and a cut command; the printer
prints and cuts. The paper used is the paper printed.

---

## Which kind of printer you have

### Network printer — the simple case

The printer has its own Ethernet socket or Wi-Fi. Print its self-test page
(hold FEED while switching it on) and read the IP address off it.

In the application: **Printing → Network printer**, enter that address, port
9100, then **Print a test page**.

Nothing to install, nothing to share. If you are buying printers, buy these.

### USB printer on a counter PC

The printer is plugged into the PC at the counter. The server cannot see it
until Windows shares it.

**On the counter PC:**

1. Settings → Printers & scanners → the printer → Printer properties
2. **Sharing** tab → tick *Share this printer*
3. Share name: something short with no spaces, e.g. `Receipt`
4. Untick *Render print jobs on client computers*
5. Note the PC's name (`hostname` in a command window)

Then in the application: **Printing → USB printer shared from a PC**, and enter
`\\COUNTER-1\Receipt`.

**If Windows asks for credentials**, the service account cannot reach the
share. The simplest fix is to give the counter PC a local user with the same
name and password as the account the HMS service runs under. The alternative
is to move the printer onto the network.

### Printer attached to the server itself

Share it exactly as above, and use `\\localhost\Receipt`. The list of printers
the server can see appears under the share path box; anything not shared there
cannot be printed to.

---

## Each counter has its own

Printer settings are per counter: the main counter, the pharmacy and the
laboratory each point at their own. That is the point — a receipt should not
come out on the laser printer in the office because that is what Windows had
set as default.

Set them from each counter's own Printing screen.

---

## When it does not work

The application says what went wrong rather than failing quietly. A cashier
who presses Print and sees nothing assumes it worked and hands the patient
nothing, which is worse than an error.

| Message | What it means |
|---|---|
| No printer is set for this counter | Nothing chosen under Printing |
| Could not reach the printer at … | Wrong IP, printer off, or a different subnet |
| It did not answer within six seconds | Reachable but not listening on 9100 |
| Windows refused the print | The share does not exist, or the service cannot reach it |
| This server is not running Windows | Shares need a Windows server; use a network printer |

### Checks worth doing in order

```powershell
ping 192.168.1.60                              # the printer answers at all
Test-NetConnection 192.168.1.60 -Port 9100     # it is listening
dir \\COUNTER-1\Receipt                        # the share exists and is reachable
```

If `Test-NetConnection` succeeds but printing does not, the printer is not in
ESC/POS mode — some models ship set to a label-printer protocol and have a
switch in their own configuration tool.

---

## Settings worth getting right

**Roll width.** 80mm gives 48 characters a line, 58mm gives 32. Set the wrong
one and lines wrap in the middle of a total.

**Feed before cut.** The blade sits about 15mm past the print head, so without
a couple of blank lines the cut lands in the last line of text. Two is usually
right; raise it if the total is being clipped.

**Copies.** Two where one goes in the file.

---

## What the counter PCs need

Nothing. No driver, no agent, no Chrome print settings. They open the
application in a browser and press Print; the server does the rest.

The one exception is the sticker sheets and the A4 lab reports, which are
still PDFs — those are downloaded and printed on an ordinary printer, because
they are genuinely pages.

---

## "The user name or password is incorrect"

The single most common failure, and it is misleading: it appears even when
nobody set a password on the share.

The server is a separate machine. It has **no sign-in on the PC holding the
printer**, so Windows refuses the copy. It is not a wrong password; there is no
password at all.

### The fix

Put a username and password for **that PC** into the counter's Printing
settings — the two boxes under the share path. They are the Windows
credentials of the machine with the printer, not credentials for this system.

The username usually needs the machine name in front of it:

```
DESKTOP-HODM0GF\Moonie
```

A local account with no password will not work over the network: Windows
refuses blank-password accounts remotely by default. Give that account a
password, or make one just for printing.

### Checking it by hand

On the server, in PowerShell:

```powershell
net use \\DESKTOP-HODM0GF\RECIEPT /user:DESKTOP-HODM0GF\Moonie
```

If that succeeds, the credentials are right and the application will work with
the same ones. If it fails, nothing in the application can help until it
doesn't.

To confirm the printer itself is fine, once connected:

```powershell
"test" | Out-File -Encoding ascii C:\temp\t.txt
copy /b C:\temp\t.txt \\DESKTOP-HODM0GF\RECIEPT
```

### The other route: allow guest access

On the PC with the printer, sharing without credentials needs guest access
turned on, which modern Windows disables by default and Group Policy often
blocks. Credentials are the reliable answer; guest access is worth trying only
where the PCs are not on a domain.

### Watch the share name

`\\DESKTOP-HODM0GF\RECIEPT` — one backslash between the PC and the share, two
at the front. Extra ones are stripped now, but a wrong share *name* is not
something software can guess. Check it on the PC: Printer properties →
Sharing → Share name.

### And the setting that mangles output

Printer properties → Sharing → **untick "Render print jobs on client
computers"**. Left on, Windows puts its driver in the path and the raw ESC/POS
bytes come out as pages of symbols.
