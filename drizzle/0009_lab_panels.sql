-- Standard reference ranges, shipped with the system.
--
-- These were living in the demo seed, which meant they existed on whichever
-- machine had run `npm run seed` and nowhere else. Pull the code onto a second
-- computer, run it against a database that was seeded before the lab module
-- existed, and every result prints with a dash where the unit and the
-- reference range should be — the code was identical, the data was not.
--
-- Reference ranges are not demo data. They are part of what the software
-- knows, the same way a tax rate or a unit name is, so they belong in a
-- migration where every database gets them exactly once.
--
-- Written to be safe on a database that already has them: a service only
-- receives a panel if it currently has none, so a hospital that has tuned its
-- own ranges to its own analyser is never overwritten.
--
-- ONE TRANSACTION PER FILE.

INSERT INTO service_parameters (service_id, name, unit, ref_low, ref_high, ref_text, display_order)
SELECT sv.id, p.name, p.unit, p.ref_low, p.ref_high, p.ref_text, p.display_order
FROM services sv
JOIN (
  VALUES
    -- Complete blood count
    ('CBC', 'Haemoglobin',              'g/dL',    12.0,     16.0,     NULL, 0),
    ('CBC', 'Total Leucocyte Count',    '/µL',     4000.0,   11000.0,  NULL, 1),
    ('CBC', 'Platelet Count',           '/µL',     150000.0, 450000.0, NULL, 2),
    ('CBC', 'Haematocrit',              '%',       36.0,     48.0,     NULL, 3),
    ('CBC', 'MCV',                      'fL',      80.0,     100.0,    NULL, 4),
    ('CBC', 'MCH',                      'pg',      27.0,     32.0,     NULL, 5),
    ('CBC', 'Neutrophils',              '%',       40.0,     75.0,     NULL, 6),
    ('CBC', 'Lymphocytes',              '%',       20.0,     45.0,     NULL, 7),
    ('CBC', 'Monocytes',                '%',       2.0,      10.0,     NULL, 8),
    ('CBC', 'Eosinophils',              '%',       1.0,      6.0,      NULL, 9),
    ('CBC', 'ESR',                      'mm/hr',   0.0,      20.0,     NULL, 10),

    -- Liver function
    ('LFT', 'Bilirubin (Total)',        'mg/dL',   0.2,      1.2,      NULL, 0),
    ('LFT', 'Bilirubin (Direct)',       'mg/dL',   0.0,      0.3,      NULL, 1),
    ('LFT', 'ALT (SGPT)',               'U/L',     7.0,      56.0,     NULL, 2),
    ('LFT', 'AST (SGOT)',               'U/L',     10.0,     40.0,     NULL, 3),
    ('LFT', 'Alkaline Phosphatase',     'U/L',     44.0,     147.0,    NULL, 4),
    ('LFT', 'Total Protein',            'g/dL',    6.0,      8.3,      NULL, 5),
    ('LFT', 'Albumin',                  'g/dL',    3.5,      5.5,      NULL, 6),

    -- Renal function
    ('RFT', 'Urea',                     'mg/dL',   15.0,     45.0,     NULL, 0),
    ('RFT', 'Creatinine',               'mg/dL',   0.6,      1.3,      NULL, 1),
    ('RFT', 'Uric Acid',                'mg/dL',   3.5,      7.2,      NULL, 2),
    ('RFT', 'Sodium',                   'mmol/L',  135.0,    145.0,    NULL, 3),
    ('RFT', 'Potassium',                'mmol/L',  3.5,      5.1,      NULL, 4),
    ('RFT', 'Chloride',                 'mmol/L',  98.0,     107.0,    NULL, 5),

    ('Blood Sugar (Fasting)', 'Glucose (Fasting)', 'mg/dL', 70.0, 100.0, NULL, 0),
    ('Blood Sugar (Random)',  'Glucose (Random)',  'mg/dL', 70.0, 140.0, NULL, 0),
    ('HbA1c',                 'HbA1c',             '%',     4.0,  5.6,   NULL, 0),

    ('Lipid Profile', 'Total Cholesterol',  'mg/dL', 0.0,  200.0, NULL, 0),
    ('Lipid Profile', 'Triglycerides',      'mg/dL', 0.0,  150.0, NULL, 1),
    ('Lipid Profile', 'HDL Cholesterol',    'mg/dL', 40.0, 60.0,  NULL, 2),
    ('Lipid Profile', 'LDL Cholesterol',    'mg/dL', 0.0,  100.0, NULL, 3),

    ('Thyroid Profile', 'TSH',      'µIU/mL', 0.4, 4.0, NULL, 0),
    ('Thyroid Profile', 'Free T4',  'ng/dL',  0.8, 1.8, NULL, 1),
    ('Thyroid Profile', 'Free T3',  'pg/mL',  2.3, 4.2, NULL, 2),

    -- Results that are words rather than numbers use ref_text instead.
    ('Urine R/E', 'Colour',          NULL,   NULL, NULL, 'Pale yellow', 0),
    ('Urine R/E', 'Appearance',      NULL,   NULL, NULL, 'Clear',       1),
    ('Urine R/E', 'Specific Gravity', NULL,  1.005, 1.030, NULL,        2),
    ('Urine R/E', 'pH',              NULL,   4.5,  8.0,  NULL,          3),
    ('Urine R/E', 'Protein',         NULL,   NULL, NULL, 'Nil',         4),
    ('Urine R/E', 'Glucose',         NULL,   NULL, NULL, 'Nil',         5),
    ('Urine R/E', 'Pus Cells',       '/HPF', 0.0,  5.0,  NULL,          6),
    ('Urine R/E', 'Red Blood Cells', '/HPF', 0.0,  2.0,  NULL,          7),
    ('Urine R/E', 'Epithelial Cells', '/HPF', 0.0, 5.0,  NULL,          8),

    ('Dengue NS1', 'Dengue NS1 Antigen', NULL, NULL, NULL, 'Negative', 0),
    ('Typhidot',   'Typhidot IgM',       NULL, NULL, NULL, 'Negative', 0),
    ('Typhidot',   'Typhidot IgG',       NULL, NULL, NULL, 'Negative', 1)
) AS p(service_name, name, unit, ref_low, ref_high, ref_text, display_order)
  ON lower(sv.name) = lower(p.service_name)
WHERE NOT EXISTS (
  SELECT 1 FROM service_parameters existing WHERE existing.service_id = sv.id
);
