-- Cross match is a service like any other, and ships with the software.
--
-- It was added by hand, which meant it had no parameters, so the laboratory's
-- Enter results screen had nothing to show and a booked cross match
-- disappeared: billed at the counter, invisible at the bench.
--
-- It is identified by its code rather than its name, because a hospital will
-- rename it — "Cross Match (Blood)", "X-Match" — and the laboratory screen
-- has to keep recognising it afterwards. The price is left at zero so the
-- hospital sets its own; an unpriced service is refused at the counter, which
-- is the correct prompt to go and set one.
--
-- ONE TRANSACTION PER FILE.

INSERT INTO services (code, name, category, price_paisa, default_share_bp, is_active)
SELECT 'XMATCH', 'Cross Match', 'lab', 0, 0, true
WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'XMATCH');
