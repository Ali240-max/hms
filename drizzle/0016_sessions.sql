-- Sessions that survive a restart.
--
-- They were held in a Map in the server's memory, which meant every restart
-- silently signed out everyone who was logged in. In development that happens
-- on every file save; in a hospital it happens whenever the service is
-- restarted for an upgrade, and a cashier halfway through a bill gets a blank
-- screen and a 401 with no explanation.
--
-- A token is not secret data worth protecting beyond this: it is a random 32
-- bytes with an expiry, and it is already sent on every request.
--
-- ONE TRANSACTION PER FILE.

CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  staff_id    integer NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_staff_idx ON sessions (staff_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
