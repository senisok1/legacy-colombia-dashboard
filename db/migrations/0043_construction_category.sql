-- Construction Management: category hierarchy (2026-08-20, Seni's ask: type
-- a category like "Gym" and list open items under it). Free-text, not a
-- separate lookup table — grouping is done client/query-side by exact string
-- match, same "just a text column" simplicity as the rest of this feature.
-- Null/blank means "Uncategorized" (see lib/construction.ts).
alter table construction_items add column if not exists category text;

create index if not exists construction_items_category_idx
  on construction_items (organization_id, property_group_id, category);
