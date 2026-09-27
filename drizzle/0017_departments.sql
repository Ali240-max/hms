-- The departments a hospital of this size actually has.
--
-- A fresh install had none, so the first administrator had to invent the list
-- before a single doctor could be added. These are the common ones; anything
-- missing is added under Administration, Departments, and anything unwanted is
-- deleted there while nothing points at it.
--
-- Added only where the name is missing, so an upgrade never duplicates or
-- overwrites a hospital's own.
--
-- ONE TRANSACTION PER FILE.

INSERT INTO departments (name, code)
SELECT v.name, v.code
FROM (VALUES
  ('General Medicine',      'MED'),
  ('General Surgery',       'SURG'),
  ('Paediatrics',           'PAED'),
  ('Gynaecology & Obstetrics', 'GYN'),
  ('Orthopaedics',          'ORTHO'),
  ('Cardiology',            'CARD'),
  ('Dermatology',           'DERM'),
  ('ENT',                   'ENT'),
  ('Eye',                   'EYE'),
  ('Dental',                'DENT'),
  ('Urology',               'URO'),
  ('Neurology',             'NEURO'),
  ('Psychiatry',            'PSY'),
  ('Gastroenterology',      'GASTRO'),
  ('Pulmonology',           'PULMO'),
  ('Nephrology',            'NEPH'),
  ('Diabetes & Endocrine',  'ENDO'),
  ('Physiotherapy',         'PHYSIO'),
  ('Emergency',             'EMER'),
  ('Laboratory',            'LAB'),
  ('Radiology',             'RAD'),
  ('Pharmacy',              'PHARM')
) AS v(name, code)
-- Skipped when either the name OR the code is already taken.
--
-- Checking only the name was not enough: a hospital already running with
-- "Gynaecology" (code GYN) does not match the name below, so the row was
-- inserted and collided on the code instead — which fails the migration and
-- stops the server from starting at all. A department that exists under any
-- spelling is left exactly as it is.
WHERE NOT EXISTS (
  SELECT 1 FROM departments d
  WHERE lower(d.name) = lower(v.name) OR upper(d.code) = upper(v.code)
);
