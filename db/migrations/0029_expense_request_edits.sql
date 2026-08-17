-- Edit tracking for Team Expense Requests (2026-08-17, Seni's ask: "add an
-- edit tab next to delete so that the team member can edit if he needs to
-- but make sure you log in that edit as well").
alter table expense_requests add column if not exists edited_at timestamptz;
alter table expense_requests add column if not exists edited_by_email text;
alter table expense_requests add column if not exists edited_by_name text;
