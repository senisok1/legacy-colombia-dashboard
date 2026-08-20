-- Estimated completion date per open item (2026-08-20, Seni's ask: "add
-- estimated date of completion for each open item for the construction
-- team to input"). Also adds a "detail" column to the activity log
-- (construction_activity_log had none before — every action was
-- self-describing from action+item_title alone) so a date change can record
-- WHAT it changed to, same shape as construction_budget_activity_log's
-- detail column added in 0046.
alter table construction_items
  add column if not exists estimated_completion_date date;

alter table construction_activity_log
  add column if not exists detail text;
