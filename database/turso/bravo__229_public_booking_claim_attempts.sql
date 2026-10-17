-- 229 - Public booking cap: a place counts the attempts holding it (2026-10-17).
--
-- 228 kept one row per booking request and gave a place back by deleting it,
-- then re-inserted it when a booking completed. Two attempts of one request
-- running at once could step on each other: a give-back by one could free the
-- place while the other booked, and a retry after the UTC day changed found
-- yesterday's row and took none of today's places (Codex review of #670).
--
-- So a place now counts the attempts that hold it. Every attempt adds one
-- (claim), and only an attempt that booked nothing takes one off (release).
-- The row goes when the count reaches zero, so no attempt can free a place
-- another still holds, and a booking that succeeds keeps its count for good
-- (lib/forms/public-booking-cap.ts).
--
-- Additive only: one column with a default, so it is safe on a table with
-- rows. A row from before this migration is one attempt holding its place.

ALTER TABLE public_booking_claims ADD COLUMN attempts integer not null default 1;
