-- Attendance from a STANDALONE TERMINAL as well as a USB reader.
--
-- The two are different machines doing different jobs, and the difference
-- decides everything below.
--
--   A READER (ZKTeco Live20R / SLK20R / ZK9500) is a piece of glass on a USB
--   cable. It has no brain. The PC holds the fingerprints, the PC does the
--   matching, and the agent already does both.
--
--   A TERMINAL (ZKTeco K50 and the rest of the standalone family) is a
--   complete computer on the wall. People are enrolled ON IT, it matches
--   them itself, and it keeps its own log. Nobody can push HMS templates
--   into it in any useful way, and there is no point trying: it already
--   knows who everybody is.
--
-- So a terminal is not a second kind of reader. It is a second SOURCE, and
-- what it hands over is already identified: a user id the device chose, and
-- a time off its own clock. The only thing missing is which HMS staff member
-- that user id belongs to, and that is what this migration adds.
--
-- ONE TRANSACTION PER FILE.

/*
 * The id this person has ON THE TERMINAL.
 *
 * Text, not an integer, because the device stores it as a string of up to 24
 * characters and sites use things like "0042" or "E-17". Reading it back as
 * a number would turn "0042" into 42 and stop it matching.
 *
 * NULL means no mapping, and then the agent falls back to treating the
 * device's user id as the HMS staff id. That is the right default for a
 * terminal enrolled from scratch alongside HMS — give somebody user id 7 on
 * the device and staff 7 gets the punch — and it means a fresh install needs
 * no mapping at all. This column exists for the other case, which is the
 * common one in practice: a terminal that was already in service with its
 * own numbering before HMS arrived.
 */
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS device_user_id text;

/*
 * Unique where it is set.
 *
 * Two people cannot share one id on the terminal, and if they did, every
 * punch from that id would land on whichever row the query happened to
 * return first — silently, and differently on different days. A partial
 * index lets the many NULLs coexist while still refusing a real duplicate.
 */
CREATE UNIQUE INDEX IF NOT EXISTS staff_device_user_uq
  ON staff (device_user_id) WHERE device_user_id IS NOT NULL;

/* -------------------------------------------------- what kind of device */

/*
 * Recorded against the device so the screen can say what it is.
 *
 * 'reader'   a USB scanner on a PC, matched by the agent
 * 'terminal' a standalone unit on the network, matched by itself
 *
 * Everything already installed is a reader, which is why that is the
 * default: an existing row must keep meaning what it meant yesterday.
 *
 * The kind changes nothing about how a punch is stored — both arrive at the
 * same route and become the same row in attendance_events. It is here so
 * that somebody looking at a list of devices can tell the thing on the wall
 * from the thing on the desk, and so the agent's own setup can be checked
 * against what HMS was told to expect.
 */
ALTER TABLE attendance_devices
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'reader';

ALTER TABLE attendance_devices
  ADD CONSTRAINT attendance_devices_kind_ck
  CHECK (kind IN ('reader', 'terminal'));

/*
 * Where the terminal is, for a reader that is not plugged into anything.
 *
 * Kept on the device row rather than only in the agent's ini file so the
 * hospital can see, from the Administration screen, which box on which wall
 * a key belongs to. The agent still reads its own address from its own
 * settings — this is documentation, not configuration, and nothing reads it
 * to decide where to connect.
 */
ALTER TABLE attendance_devices
  ADD COLUMN IF NOT EXISTS host text;
