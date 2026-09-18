-- A place to keep the hospital's logo.
--
-- Stored in the database rather than as a file on disk so it survives a
-- reinstall, travels with a backup, and is there for every machine on the
-- network without anyone copying a file around. A logo is a few tens of
-- kilobytes; that is a fair price for never having to explain where to put it.
--
-- Held as a data URI so the report generator can embed it without touching
-- the filesystem at print time.
--
-- ONE TRANSACTION PER FILE.

INSERT INTO settings (key, value)
VALUES ('hospital.logoDataUri', '')
ON CONFLICT (key) DO NOTHING;
