# Complete source, v13

Replaces everything. Unzip into a fresh folder, copy your `.env` across, then:

```powershell
npm install
npm run typecheck
npm run build
```

Migration `0016_sessions.sql` runs on first start.

## What changed in this build

**Sessions now live in the database.** They were a Map in the server's memory,
so every restart silently signed out everyone who was logged in. That is what
produced the blank billing screen and the 401s: the token in the browser no
longer matched anything on the server. In development this happened on every
file save; in a hospital it would happen on every upgrade, to every counter
mid-bill.

**PDF preview removed everywhere.** Print buttons now download the file
directly. Asking a browser to display a PDF in a frame was unreliable by
design: a browser set to download them instead showed an empty frame, and
printing that frame printed the viewer rather than the document. `pdfjs-dist`
is gone from the dependencies with it.

**A lab report with nothing finished on it** now returns a clear message
instead of an empty 204 that a viewer reported as "Unexpected server
response".

**New sign-in screen.** Two columns, no department buttons. The old grid told
anybody at an unattended counter which departments exist and what each is
called, and bought nothing, because a username already knows its own role.

Because module toggles used to work by hiding sign-in buttons, that check
moved: somebody whose department is switched off signs in and is told so.

**Lab stage column** holds several badges without clipping them.
