-- Event start time for the Management tab's per-stay event flag
-- (2026-08-16, Seni's ask: a time dropdown next to the date dropdown).
-- Stored as plain text "HH:MM" (24h) so there's no timezone ambiguity —
-- this is a local wall-clock time at the property.
alter table booking_ops add column if not exists event_time text;
