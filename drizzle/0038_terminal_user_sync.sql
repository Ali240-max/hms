-- Creating staff on the network terminal from HMS.
--
-- Until now every person had to be typed into the K50's own menus, and then
-- their id on the device typed into HMS by hand. Two people doing two halves
-- of one job is how nineteen ids came to be paired with the wrong names.
--
-- HMS cannot reach the terminal itself. The terminal is spoken to by the
-- attendance agent, on a PC near it, which already polls it for punches. So
-- the request is written here as a JOB, the agent picks it up on its next
-- pass, does it over the connection it already uses, and writes the outcome
-- back. Nothing ever opens a second connection to the device.
--
-- ONE TRANSACTION PER FILE.

CREATE TABLE IF NOT EXISTS attendance_device_jobs (
  id              serial PRIMARY KEY,
  device_id       integer NOT NULL REFERENCES attendance_devices(id),
  staff_id        integer NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  /* Only one kind so far. Named so a second can be added without a rename. */
  kind            text NOT NULL DEFAULT 'sync_user',
  /*
   * The id the person will have ON THE DEVICE, and the name written there.
   *
   * Both are fixed when the job is made rather than read again when it runs,
   * so the agent writes exactly what the administrator was shown.
   */
  device_user_id  text NOT NULL,
  name            text NOT NULL,
  /*
   * pending  waiting for the agent
   * running  the agent has it
   * done     the device confirmed the person is there
   * failed   it did not, and `message` says why
   */
  status          text NOT NULL DEFAULT 'pending',
  /* CREATED, ALREADY_PRESENT, CONFLICT, DEVICE_ERROR, ... for the screen. */
  result_code     text,
  message         text,
  /* What the device itself holds under that id, after the job ran. */
  device_name     text,
  requested_by    text,
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  finished_at     timestamptz
);

ALTER TABLE attendance_device_jobs
  ADD CONSTRAINT attendance_device_jobs_kind_ck CHECK (kind IN ('sync_user'));
ALTER TABLE attendance_device_jobs
  ADD CONSTRAINT attendance_device_jobs_status_ck
  CHECK (status IN ('pending', 'running', 'done', 'failed'));

CREATE INDEX IF NOT EXISTS attendance_device_jobs_open_idx
  ON attendance_device_jobs (device_id, status, id);
CREATE INDEX IF NOT EXISTS attendance_device_jobs_staff_idx
  ON attendance_device_jobs (staff_id, id);

/*
 * One open job per person per device.
 *
 * Pressing the button twice, or two administrators pressing it at once, must
 * not queue two writes for one person. The second request is handed the job
 * that is already waiting.
 */
CREATE UNIQUE INDEX IF NOT EXISTS attendance_device_jobs_one_open_uq
  ON attendance_device_jobs (device_id, staff_id)
  WHERE status IN ('pending', 'running');

/*
 * And one open job per device id.
 *
 * Two different people queued for the same id on the same device would both
 * be told the id was free, and the second write would land on top of the
 * first person.
 */
CREATE UNIQUE INDEX IF NOT EXISTS attendance_device_jobs_one_id_uq
  ON attendance_device_jobs (device_id, device_user_id)
  WHERE status IN ('pending', 'running');
