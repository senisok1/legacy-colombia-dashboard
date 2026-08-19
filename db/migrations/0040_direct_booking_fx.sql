-- Locked per-booking FX rate for Gabriel's direct-booking commissions
-- (2026-08-19, Seni's ask: "The USD to COP conversion rate for that day
-- needs to be locked in for that specific booking and not change").
-- Captured once when the booking is first detected/synced (see
-- lib/directBookingCommissions.ts syncDirectBookingCommissions) and never
-- updated after — display and settlement math for this line use this rate
-- instead of the live rate. Nullable: rows that existed before this
-- migration get backfilled with the rate on their next sync (the true
-- booking-day rate for those is unrecoverable).
alter table direct_booking_commissions
  add column if not exists fx_rate numeric(14,4),
  add column if not exists fx_locked_at timestamptz;
