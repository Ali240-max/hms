-- Pharmaceutical companies in the Pakistani market, shipped with the software.
--
-- The multinationals with Pakistani operations and the well-established local
-- manufacturers, written out once and properly cased. A fresh install needs
-- these before anyone can add a medicine.
--
-- Deliberately a list of companies known to exist rather than a long one. A
-- shorter list the pharmacy extends is better than a longer one containing a
-- name nobody can place — the next person would have no way to tell the real
-- entries from the invented ones.
--
-- The companies list shipped in 0012 came from a twenty-year-old system and is
-- in capitals — "GETZ PHARMA". Names are unique regardless of case, so a
-- plain insert of "Getz Pharma" would collide and be skipped, leaving the
-- capitals in place. Where the existing name is entirely upper case, it is
-- therefore re-cased to the proper spelling.
--
-- Only then. A name somebody has typed in mixed case is a deliberate choice
-- and is left exactly as it is. Anything absent is added under Suppliers &
-- formulas in the pharmacy.
--
-- ONE TRANSACTION PER FILE.

INSERT INTO manufacturers (name, short_name)
VALUES
  ('Abbott Laboratories (Pakistan)', 'Abbott'),
  ('GlaxoSmithKline Pakistan', 'GSK'),
  ('Haleon Pakistan', 'Haleon'),
  ('Sanofi-Aventis Pakistan', 'Sanofi'),
  ('Pfizer Pakistan', 'Pfizer'),
  ('Novartis Pharma (Pakistan)', 'Novartis'),
  ('Bayer Pakistan', 'Bayer'),
  ('Merck Pakistan', 'Merck'),
  ('Roche Pakistan', 'Roche'),
  ('AstraZeneca Pakistan', 'AstraZeneca'),
  ('Boehringer Ingelheim Pakistan', 'Boehringer'),
  ('Novo Nordisk Pakistan', 'Novo Nordisk'),
  ('Eli Lilly Pakistan', 'Lilly'),
  ('Reckitt Benckiser Pakistan', 'Reckitt'),
  ('Servier Pakistan', 'Servier'),
  ('B. Braun Pakistan', 'B. Braun'),
  ('Sandoz Pakistan', 'Sandoz'),
  ('Otsuka Pakistan', 'Otsuka'),
  ('AGP Limited', 'AGP'),
  ('Getz Pharma', 'Getz'),
  ('The Searle Company', 'Searle'),
  ('Ferozsons Laboratories', 'Ferozsons'),
  ('Highnoon Laboratories', 'Highnoon'),
  ('Sami Pharmaceuticals', 'Sami'),
  ('CCL Pharmaceuticals', 'CCL'),
  ('Hilton Pharma', 'Hilton'),
  ('Martin Dow', 'Martin Dow'),
  ('Genix Pharma', 'Genix'),
  ('Bosch Pharmaceuticals', 'Bosch'),
  ('Wilshire Laboratories', 'Wilshire'),
  ('Barrett Hodgson Pakistan', 'Barrett Hodgson'),
  ('Hi-Tech Pharmaceuticals', 'Hi-Tech'),
  ('Nabiqasim Industries', 'Nabiqasim'),
  ('Platinum Pharmaceuticals', 'Platinum'),
  ('PharmEvo', 'PharmEvo'),
  ('Macter International', 'Macter'),
  ('Atco Laboratories', 'Atco'),
  ('Indus Pharma', 'Indus'),
  ('Medisure Laboratories', 'Medisure'),
  ('Scilife Pharma', 'Scilife'),
  ('Tabros Pharma', 'Tabros'),
  ('Zafa Pharmaceutical Laboratories', 'Zafa'),
  ('Helix Pharma', 'Helix'),
  ('OBS Pakistan', 'OBS'),
  ('Schazoo Zaka', 'Schazoo'),
  ('Shaigan Pharmaceuticals', 'Shaigan'),
  ('Sante Pharmaceuticals', 'Sante'),
  ('Standpharm Pakistan', 'Standpharm'),
  ('Surge Laboratories', 'Surge'),
  ('Efroze Chemical Industries', 'Efroze'),
  ('Reko Pharmacal', 'Reko'),
  ('Qarshi Industries', 'Qarshi'),
  ('Hamdard Laboratories (Waqf) Pakistan', 'Hamdard'),
  ('Stiefel Laboratories Pakistan', 'Stiefel'),
  ('Global Pharmaceuticals', 'Global'),
  ('Horizon Pharmaceuticals', 'Horizon')
ON CONFLICT (lower(name)) DO UPDATE
  SET name = EXCLUDED.name,
      short_name = COALESCE(manufacturers.short_name, EXCLUDED.short_name)
  WHERE manufacturers.name = upper(manufacturers.name);

-- Retire the unused capitals.
--
-- The inherited list has near-duplicates the re-casing above cannot catch,
-- because the strings differ as well as the case: "SEARLE" beside "The Searle
-- Company", "HIGHNOON LAB" beside "Highnoon Laboratories". Offering both in a
-- dropdown is how one company ends up split across two, and every report by
-- company is then wrong.
--
-- So an entry still entirely in capitals, and not yet used by any medicine, is
-- switched off. Switched off, not deleted: it stops appearing in the
-- dropdown, it can be switched back on, and anything already pointing at it
-- is left untouched.
UPDATE manufacturers m
SET is_active = false
WHERE m.name = upper(m.name)
  AND m.name ~ '[A-Z]'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.manufacturer_id = m.id);
