-- A login that can only show the scan board.
--
-- The screen by the door stays signed in all day on a machine anybody can walk
-- up to, so it must not be a ward or administrator session left open. This
-- role can read the last few scans and nothing else: no patients, no bills, no
-- staff list.
--
-- A login rather than an open page, because the board is a list of who is in
-- the building and when they arrived. "It only shows names" is the reason it
-- is worth protecting, not the reason it is not: on a hospital LAN that is
-- staff movement, including which nurse is alone on a night shift.
--
-- ONE TRANSACTION PER FILE.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'kiosk';
