-- The common laboratory tests and radiology procedures, shipped with the software.
--
-- A new hospital should open the lab on day one with CBC, LFT, RFT and the rest
-- already defined, reference ranges included, rather than typing twenty CBC
-- parameters by hand before the first patient can be seen.
--
-- Shipped WITHOUT a price. Only the hospital knows what it charges, and a
-- guessed figure is worse than none: it would be billed until somebody
-- noticed. An unpriced test is refused at the counter and at the doctor's
-- desk with a message saying where to set it, so nothing is ever billed at
-- zero by accident.
--
-- Everything here is an ordinary service afterwards: renamed, repriced,
-- switched off or given different ranges under Administration, Services.
-- Rows are only added where missing, matched by name regardless of case, so
-- a hospital's own edits are never overwritten by a later upgrade.
--
-- ONE TRANSACTION PER FILE.

INSERT INTO services (name, category, price_paisa, default_share_bp)
SELECT v.name, v.category::service_category, 0, 0
FROM (VALUES
  ('CBC', 'lab'),
  ('ESR', 'lab'),
  ('Blood Group & Rh', 'lab'),
  ('PT / INR', 'lab'),
  ('APTT', 'lab'),
  ('Malaria Parasite (MP)', 'lab'),
  ('Blood Sugar (Fasting)', 'lab'),
  ('Blood Sugar (Random)', 'lab'),
  ('HbA1c', 'lab'),
  ('LFT', 'lab'),
  ('RFT', 'lab'),
  ('Serum Electrolytes', 'lab'),
  ('Lipid Profile', 'lab'),
  ('Thyroid Profile', 'lab'),
  ('Serum Calcium', 'lab'),
  ('Serum Uric Acid', 'lab'),
  ('Serum Amylase', 'lab'),
  ('CRP', 'lab'),
  ('Urine R/E', 'lab'),
  ('Stool R/E', 'lab'),
  ('HBsAg', 'lab'),
  ('Anti-HCV', 'lab'),
  ('HIV (Screening)', 'lab'),
  ('Dengue NS1', 'lab'),
  ('Typhidot', 'lab'),
  ('Widal Test', 'lab'),
  ('H. pylori (Antigen)', 'lab'),
  ('RA Factor', 'lab'),
  ('Pregnancy Test (Urine)', 'lab'),
  ('X-Ray Chest PA', 'radiology'),
  ('X-Ray Abdomen', 'radiology'),
  ('X-Ray Skull', 'radiology'),
  ('X-Ray PNS', 'radiology'),
  ('X-Ray Cervical Spine', 'radiology'),
  ('X-Ray Lumbar Spine', 'radiology'),
  ('X-Ray Pelvis', 'radiology'),
  ('X-Ray Shoulder', 'radiology'),
  ('X-Ray Knee', 'radiology'),
  ('X-Ray Hand / Wrist', 'radiology'),
  ('X-Ray Foot / Ankle', 'radiology'),
  ('X-Ray Elbow', 'radiology'),
  ('Ultrasound Abdomen', 'radiology'),
  ('Ultrasound Pelvis', 'radiology'),
  ('Ultrasound KUB', 'radiology'),
  ('Ultrasound Obstetric', 'radiology'),
  ('Ultrasound Thyroid', 'radiology'),
  ('Ultrasound Breast', 'radiology'),
  ('Doppler Ultrasound', 'radiology')
) AS v(name, category)
WHERE NOT EXISTS (
  SELECT 1 FROM services sv WHERE lower(sv.name) = lower(v.name)
);

-- Reference ranges, only for a test that has none yet. A lab that has tuned
-- ranges to its own analyser keeps them.
INSERT INTO service_parameters (service_id, name, unit, ref_low, ref_high, ref_text, display_order)
SELECT sv.id, p.name, p.unit, p.ref_low, p.ref_high, p.ref_text, p.display_order
FROM (VALUES
  ('CBC', 'Haemoglobin', 'g/dL', 12, 16, NULL, 0),
  ('CBC', 'Total Leucocyte Count', '/µL', 4000, 11000, NULL, 1),
  ('CBC', 'Red Blood Cell Count', 'million/µL', 4.2, 5.9, NULL, 2),
  ('CBC', 'Haematocrit', '%', 36, 48, NULL, 3),
  ('CBC', 'MCV', 'fL', 80, 100, NULL, 4),
  ('CBC', 'MCH', 'pg', 27, 32, NULL, 5),
  ('CBC', 'MCHC', 'g/dL', 32, 36, NULL, 6),
  ('CBC', 'Platelet Count', '/µL', 150000, 450000, NULL, 7),
  ('CBC', 'Neutrophils', '%', 40, 75, NULL, 8),
  ('CBC', 'Lymphocytes', '%', 20, 45, NULL, 9),
  ('CBC', 'Monocytes', '%', 2, 10, NULL, 10),
  ('CBC', 'Eosinophils', '%', 1, 6, NULL, 11),
  ('ESR', 'ESR', 'mm/hr', 0, 20, NULL, 0),
  ('Blood Group & Rh', 'ABO Group', NULL, NULL, NULL, '—', 0),
  ('Blood Group & Rh', 'Rh Factor', NULL, NULL, NULL, '—', 1),
  ('PT / INR', 'Prothrombin Time', 'sec', 11, 13.5, NULL, 0),
  ('PT / INR', 'INR', NULL, 0.8, 1.2, NULL, 1),
  ('APTT', 'APTT', 'sec', 25, 35, NULL, 0),
  ('Malaria Parasite (MP)', 'Malaria Parasite', NULL, NULL, NULL, 'Not seen', 0),
  ('Blood Sugar (Fasting)', 'Glucose (Fasting)', 'mg/dL', 70, 100, NULL, 0),
  ('Blood Sugar (Random)', 'Glucose (Random)', 'mg/dL', 70, 140, NULL, 0),
  ('HbA1c', 'HbA1c', '%', 4, 5.6, NULL, 0),
  ('LFT', 'Bilirubin (Total)', 'mg/dL', 0.2, 1.2, NULL, 0),
  ('LFT', 'Bilirubin (Direct)', 'mg/dL', 0, 0.3, NULL, 1),
  ('LFT', 'ALT (SGPT)', 'U/L', 7, 56, NULL, 2),
  ('LFT', 'AST (SGOT)', 'U/L', 10, 40, NULL, 3),
  ('LFT', 'Alkaline Phosphatase', 'U/L', 44, 147, NULL, 4),
  ('LFT', 'Total Protein', 'g/dL', 6, 8.3, NULL, 5),
  ('LFT', 'Albumin', 'g/dL', 3.5, 5.5, NULL, 6),
  ('RFT', 'Urea', 'mg/dL', 15, 45, NULL, 0),
  ('RFT', 'Creatinine', 'mg/dL', 0.6, 1.3, NULL, 1),
  ('RFT', 'Uric Acid', 'mg/dL', 3.5, 7.2, NULL, 2),
  ('Serum Electrolytes', 'Sodium', 'mmol/L', 135, 145, NULL, 0),
  ('Serum Electrolytes', 'Potassium', 'mmol/L', 3.5, 5.1, NULL, 1),
  ('Serum Electrolytes', 'Chloride', 'mmol/L', 98, 107, NULL, 2),
  ('Lipid Profile', 'Total Cholesterol', 'mg/dL', 0, 200, NULL, 0),
  ('Lipid Profile', 'Triglycerides', 'mg/dL', 0, 150, NULL, 1),
  ('Lipid Profile', 'HDL Cholesterol', 'mg/dL', 40, 60, NULL, 2),
  ('Lipid Profile', 'LDL Cholesterol', 'mg/dL', 0, 100, NULL, 3),
  ('Thyroid Profile', 'TSH', 'µIU/mL', 0.4, 4.0, NULL, 0),
  ('Thyroid Profile', 'Free T4', 'ng/dL', 0.8, 1.8, NULL, 1),
  ('Thyroid Profile', 'Free T3', 'pg/mL', 2.3, 4.2, NULL, 2),
  ('Serum Calcium', 'Calcium', 'mg/dL', 8.5, 10.5, NULL, 0),
  ('Serum Uric Acid', 'Uric Acid', 'mg/dL', 3.5, 7.2, NULL, 0),
  ('Serum Amylase', 'Amylase', 'U/L', 30, 110, NULL, 0),
  ('CRP', 'C-Reactive Protein', 'mg/L', 0, 5, NULL, 0),
  ('Urine R/E', 'Colour', NULL, NULL, NULL, 'Pale yellow', 0),
  ('Urine R/E', 'Appearance', NULL, NULL, NULL, 'Clear', 1),
  ('Urine R/E', 'Specific Gravity', NULL, 1.005, 1.03, NULL, 2),
  ('Urine R/E', 'pH', NULL, 4.5, 8.0, NULL, 3),
  ('Urine R/E', 'Protein', NULL, NULL, NULL, 'Nil', 4),
  ('Urine R/E', 'Glucose', NULL, NULL, NULL, 'Nil', 5),
  ('Urine R/E', 'Pus Cells', '/HPF', 0, 5, NULL, 6),
  ('Urine R/E', 'Red Blood Cells', '/HPF', 0, 2, NULL, 7),
  ('Stool R/E', 'Consistency', NULL, NULL, NULL, 'Formed', 0),
  ('Stool R/E', 'Ova / Cysts', NULL, NULL, NULL, 'Not seen', 1),
  ('Stool R/E', 'Pus Cells', '/HPF', 0, 5, NULL, 2),
  ('HBsAg', 'HBsAg', NULL, NULL, NULL, 'Non-reactive', 0),
  ('Anti-HCV', 'Anti-HCV', NULL, NULL, NULL, 'Non-reactive', 0),
  ('HIV (Screening)', 'HIV 1 & 2', NULL, NULL, NULL, 'Non-reactive', 0),
  ('Dengue NS1', 'Dengue NS1 Antigen', NULL, NULL, NULL, 'Negative', 0),
  ('Typhidot', 'Typhidot IgM', NULL, NULL, NULL, 'Negative', 0),
  ('Typhidot', 'Typhidot IgG', NULL, NULL, NULL, 'Negative', 1),
  ('Widal Test', 'S. Typhi O', NULL, NULL, NULL, 'Below 1:80', 0),
  ('Widal Test', 'S. Typhi H', NULL, NULL, NULL, 'Below 1:80', 1),
  ('H. pylori (Antigen)', 'H. pylori', NULL, NULL, NULL, 'Negative', 0),
  ('RA Factor', 'Rheumatoid Factor', 'IU/mL', 0, 14, NULL, 0),
  ('Pregnancy Test (Urine)', 'Urine β-hCG', NULL, NULL, NULL, 'Negative', 0)
) AS p(service_name, name, unit, ref_low, ref_high, ref_text, display_order)
JOIN services sv ON lower(sv.name) = lower(p.service_name)
WHERE NOT EXISTS (
  SELECT 1 FROM service_parameters x WHERE x.service_id = sv.id
);
