-- Adds vendor-notify tracking to work_orders (Maintenance Manager,
-- 2026-08-04) — mirrors gabriel_notified_at from 0007_maintenance.sql. Set
-- only once a WhatsApp send to the assigned vendor actually succeeds (see
-- lib/maintenanceVendorNotify.ts), so the UI never claims a notify that
-- didn't happen.
--
-- Applied via GET /api/admin/migrate?secret=... (see that route's comment).

alter table work_orders add column if not exists vendor_notified_at timestamptz;
