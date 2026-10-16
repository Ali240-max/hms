-- Service categories a hospital can add to, and a token queue per department.
--
-- 1. service_categories: the groups the Services screen, the Main Counter's
--    "what are they here for?" boxes and the token queues are built from.
--    Until now the four groups — lab, radiology, procedure, other — were the
--    `service_category` enum, repeated as hard-coded lists in half a dozen
--    screens, so a hospital that opened a dental room had nowhere to put
--    "Dental procedures" except under "Procedure" or "Other".
--
--    The enum is NOT dropped. It stays on services as `category`, and it now
--    means "what kind of work this is": lab and radiology results are entered
--    on their own screens, procedures usually need a doctor named, and the
--    doctors' earnings report splits on it. Every new category is created as
--    one of those four kinds, and saving a service copies the kind from its
--    category, so every existing rule keeps working without knowing that
--    categories became rows.
--
--    The four shipped categories are seeded from the enum (is_builtin), with
--    the laboratory and radiology mapped to those departments when the
--    hospital has them. Built-in rows can be renamed and re-mapped but not
--    deleted: they are what an old backup's services fall back to.
--
-- 2. services.category_id: backfilled from the kind, so every existing
--    service lands in the category that shows exactly what it showed before.
--    Nothing else on the service is touched — its price, share, department
--    and history stay as they were.
--
-- 3. chits.token_no / chits.department_id: the token a department calls out.
--    Tokens used to live only on the visit, from ONE daily counter for every
--    doctor (and a second one for walk-in tests), so the laboratory called
--    out whatever number the consultation had happened to get. A chit is the
--    slip a patient carries to a department, so the department's own token
--    goes on it. Old chits keep NULL and are shown with the visit's token,
--    exactly as they were printed.
--
-- ONE TRANSACTION PER FILE.

CREATE TABLE IF NOT EXISTS service_categories (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  -- How services in this category behave. See the header.
  kind           service_category NOT NULL DEFAULT 'procedure',
  -- Which department's token queue and reports this category belongs to.
  department_id  integer REFERENCES departments(id),
  is_builtin     boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_categories_name_uq
  ON service_categories (lower(btrim(name)));

-- The four groups the screens used to hard-code, under the names the
-- Services tabs already showed. Skipped where a row of that kind is already
-- marked built in, so the file is safe to replay.
INSERT INTO service_categories (name, kind, department_id, is_builtin, sort_order)
SELECT v.name, v.kind::service_category,
       (SELECT d.id FROM departments d
        WHERE v.dept_code IS NOT NULL AND upper(d.code) = v.dept_code
        ORDER BY d.id LIMIT 1),
       true, v.sort_order
FROM (VALUES
  ('Laboratory tests',     'lab',       'LAB', 10),
  ('Radiology procedures', 'radiology', 'RAD', 20),
  ('Procedures',           'procedure', NULL,  30),
  ('Other',                'other',     NULL,  40)
) AS v(name, kind, dept_code, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM service_categories sc
  WHERE sc.is_builtin AND sc.kind = v.kind::service_category)
  AND NOT EXISTS (
  SELECT 1 FROM service_categories sc WHERE lower(btrim(sc.name)) = lower(v.name));

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS category_id integer REFERENCES service_categories(id);
CREATE INDEX IF NOT EXISTS services_category_id_idx ON services (category_id);

UPDATE services sv SET category_id = (
  SELECT sc.id FROM service_categories sc
  WHERE sc.kind = sv.category
  ORDER BY sc.is_builtin DESC, sc.id LIMIT 1)
WHERE sv.category_id IS NULL;

ALTER TABLE chits ADD COLUMN IF NOT EXISTS token_no integer;
ALTER TABLE chits ADD COLUMN IF NOT EXISTS department_id integer REFERENCES departments(id);
