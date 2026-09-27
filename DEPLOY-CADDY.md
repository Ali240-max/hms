# Short address instead of an IP and a port

Goal: staff open **`http://hms`** rather than `http://192.168.1.50:4000`.

Two separate problems, and it is worth knowing which is which:

1. **The port.** Caddy listens on 80 and passes the request to the application
   on 4000, so `:4000` disappears from the address.
2. **The name.** `hms` has to resolve to the server. Caddy cannot do this. It
   is a naming problem, solved below.

If you only fix the name and not the port, staff type `http://hms:4000`, which
is already most of the way there. If you are short of time, do the name first.

---

## Take this with you

Caddy has to be downloaded before you leave: **`caddy_windows_amd64.exe`** from
caddyserver.com/download. Rename it to `caddy.exe`.

---

## 1. The name

### Easiest: rename the server

Windows machines answer to their own computer name on a local network without
any DNS server, any router configuration, or anything on the client machines.

```powershell
Rename-Computer -NewName "hms" -Restart
```

After the reboot, every Windows PC on the same network can open `http://hms`.
Nothing else to configure. This is almost always the right answer for a
hospital LAN.

It works because Windows resolves names on the local link itself. Two things
to know: it only works on the same subnet, and Android or iOS devices may not
resolve it, so keep the IP address written down for phones.

### If renaming is not allowed

Add a line to each machine's hosts file. Tedious, but it works everywhere:

```powershell
# Run PowerShell as Administrator on each client PC
Add-Content C:\Windows\System32\drivers\etc\hosts "`n192.168.1.50`thms"
```

### Best, if the router allows it

Add a static DNS entry `hms -> 192.168.1.50` on the router. One place, every
device, phones included. Most consumer routers in Pakistan do not offer this;
look for "DNS host names", "local DNS" or "address reservation".

**Whichever you choose, give the server a fixed IP address**, or a DHCP
reservation. If the address changes, every machine loses the system at once.

---

## 2. The port

```powershell
New-Item -ItemType Directory C:\caddy -Force
Copy-Item D:\caddy.exe C:\caddy\caddy.exe
```

Create `C:\caddy\Caddyfile` — **no extension**, save it from Notepad with the
filename in quotes or you will get `Caddyfile.txt`:

```
{
	# No certificates. This is a private network with no internet, and Caddy
	# would otherwise try to reach Let's Encrypt on startup, fail, and retry
	# forever. Plain HTTP is correct here; the traffic never leaves the
	# building.
	auto_https off
	admin off
}

:80 {
	encode gzip

	# Answers on any name or address that reaches this machine on port 80,
	# so the computer name, the IP and anything added to a hosts file all
	# work without listing them here.
	reverse_proxy 127.0.0.1:4000 {
		# The application streams PDFs; give a slow printer room to finish.
		flush_interval -1
	}
}
```

Test it in the foreground first:

```powershell
cd C:\caddy
.\caddy.exe run --config Caddyfile
```

From another PC, open `http://hms`. You should get the sign-in screen. Ctrl+C
to stop.

### Install it as a service

```powershell
cd C:\hms
.\nssm.exe install caddy "C:\caddy\caddy.exe" "run --config C:\caddy\Caddyfile"
.\nssm.exe set caddy AppDirectory C:\caddy
.\nssm.exe set caddy AppStdout C:\caddy\caddy.log
.\nssm.exe set caddy AppStderr C:\caddy\caddy.log
.\nssm.exe set caddy Start SERVICE_AUTO_START
.\nssm.exe set caddy DependOnService hms
Start-Service caddy
Get-Service hms, caddy
```

`DependOnService hms` starts the application first, so Caddy never comes up
pointing at nothing after a power cut.

### Firewall

```powershell
New-NetFirewallRule -DisplayName "HMS web" -Direction Inbound `
  -LocalPort 80 -Protocol TCP -Action Allow -Profile Private,Domain
```

You can now remove the rule for 4000 if you made one: nothing outside the
server needs that port any more.

---

## If port 80 is taken

IIS is installed and running on many Windows Server machines and holds port 80.

```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 80).OwningProcess
```

If it is `System` or `w3wp`, stop the World Wide Web Publishing Service:

```powershell
Stop-Service W3SVC
Set-Service W3SVC -StartupType Disabled
```

---

## The last mile, which matters more than any of this

Even with `http://hms`, somebody has to type it the first time. On each
counter PC:

1. Open `http://hms`
2. Set it as the browser's home page, and as the page that opens on startup
3. Drag the padlock area of the address bar onto the desktop to make a
   shortcut, rename it "Hospital System"
4. Pin that shortcut to the taskbar

Then nobody types anything. Honestly, doing just this with the plain
`http://192.168.1.50:4000` address solves the complaint on its own, and it
takes two minutes per machine with nothing new to install or maintain. Caddy
is worth it for the tidier address and for having one thing to point people
at, not because typing was ever the real cost.

---

## Checking it afterwards

```powershell
Get-Service hms, caddy          # both Running
Invoke-WebRequest http://localhost/api/health | Select -Expand Content
Get-Content C:\caddy\caddy.log -Tail 20
```

If `http://hms` fails from a client but `http://192.168.1.50` works, it is the
name, not Caddy. If both fail but `http://localhost` works on the server, it is
the firewall.
