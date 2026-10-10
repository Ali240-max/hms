-- Attendance.
--
-- A punch is a fact: this person was at this reader at this moment. Everything
-- else — arrived, left, late, absent, hours — is an opinion derived from those
-- facts, and opinions change the first time somebody asks about a night shift.
-- So the punches are kept forever and nothing else is stored.
--
-- ONE TRANSACTION PER FILE.

/* ------------------------------------------------- what a shift looks like */

/*
 * A shift lives on the staff member, because that is where it is set and
 * where it is read. Nullable: somebody with no shift set is simply not
 * expected at a particular hour, which is different from being exempt.
 *
 * `attendance_required` is the exemption. A consultant on a share arrangement
 * who comes when there are patients should not appear on an absentee list
 * every morning, and the list is worthless if it is full of people nobody
 * expected.
 */
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS shift_start time,
  ADD COLUMN IF NOT EXISTS shift_end   time,
  ADD COLUMN IF NOT EXISTS attendance_required boolean NOT NULL DEFAULT true;

/* --------------------------------------------------------------- readers */

CREATE TABLE IF NOT EXISTS attendance_devices (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  location     text,
  -- The agent sends this with every post. Not a password anybody types, just
  -- something that stops a stray script on the LAN writing attendance.
  api_key      text NOT NULL,
  last_seen_at timestamptz,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_devices_key_uq ON attendance_devices (api_key);

/* ------------------------------------------------- the fingerprints */

/*
 * Templates, never images.
 *
 * A template cannot be turned back into a usable print, which is the whole
 * reason to store one. Two fingers per person is the default: one cut thumb
 * should not lock somebody out of the building.
 */
CREATE TABLE IF NOT EXISTS staff_fingerprints (
  id            serial PRIMARY KEY,
  staff_id      integer NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  finger_index  integer NOT NULL DEFAULT 1,
  template      text NOT NULL,
  enrolled_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_fingerprints_uq
  ON staff_fingerprints (staff_id, finger_index);

/* ------------------------------------------------------------- the punches */

CREATE TABLE IF NOT EXISTS attendance_events (
  id          serial PRIMARY KEY,
  staff_id    integer NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  -- device | manual. A manual punch carries who added it and why, because it
  -- is the one somebody could abuse and the one that will be questioned.
  source      text NOT NULL DEFAULT 'device',
  device_id   integer REFERENCES attendance_devices(id),
  /*
   * Which day this punch belongs to.
   *
   * Not always the calendar date. A night nurse starting at 20:00 and leaving
   * at 04:00 has both punches on one shift, and splitting them across two
   * dates makes her look absent on both. Worked out when the punch is
   * recorded, from the shift she was on.
   */
  work_date   date NOT NULL,
  note        text,
  added_by    text,
  -- Exactly what the agent sent, kept so a disputed punch can be traced back
  -- to the bytes rather than to our reading of them.
  raw         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_events_staff_idx
  ON attendance_events (staff_id, work_date, at);
CREATE INDEX IF NOT EXISTS attendance_events_date_idx
  ON attendance_events (work_date, at);

/*
 * The same punch cannot land twice.
 *
 * An agent that posted, lost the connection and retried would otherwise
 * create a second arrival a few seconds after the first. The five-minute
 * rule in the service handles a finger pressed twice; this handles the
 * network.
 */
CREATE UNIQUE INDEX IF NOT EXISTS attendance_events_once
  ON attendance_events (staff_id, at);
