-- Number of people attending the event (2026-08-16, Seni's ask: a guest-count
-- dropdown next to the event time, plus an Event-only list that shows it).
alter table booking_ops add column if not exists event_guest_count integer;
