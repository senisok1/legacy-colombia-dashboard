-- Per-user interface/notes language (2026-08-16, Seni's ask): a team member
-- can be set up in their own language so they read the Management tab and
-- write notes in it; notes are stored with BOTH the original text and an
-- English translation so an English-speaking admin always reads English.
alter table users add column if not exists language text not null default 'English';

-- Original-language text + author language for team notes/activities. The
-- existing `body` column always holds ENGLISH (translated on write when
-- needed), so every existing row stays correct with no backfill.
alter table team_activities add column if not exists body_original text;
alter table team_activities add column if not exists author_language text;
