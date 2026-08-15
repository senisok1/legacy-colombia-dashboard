-- Per-organization color scheme, picked from src/lib/themes.ts's THEMES
-- list via the new Settings > Appearance picker. Added 2026-08-05, right
-- after the visual refresh (migration 0017) that introduced the app's
-- first hardcoded accent color. Defaults every existing/new org to
-- 'indigo' (that original color), except Legacy Estate Rentals itself,
-- which Seni asked to switch to 'red-black'.

alter table organizations add column if not exists theme text not null default 'indigo';

update organizations set theme = 'red-black' where slug = 'legacy-estate-rentals';
