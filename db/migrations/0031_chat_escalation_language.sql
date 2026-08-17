-- Language round-trip for website chat inquiries (2026-08-17).
--
-- Guest MESSAGES already round-tripped correctly: lib/aiReply.ts asks Claude
-- for the guest's language plus English translations, so the WhatsApp alert
-- shows English and an "EDIT: ..." answer is translated back before sending.
-- Website chat escalations had no equivalent — a Spanish visitor's question
-- reached Seni untranslated, and his English answer went back untranslated.
--
-- `language` is the human-readable NAME ("Spanish"), matching what
-- translateToLanguage() expects for the return trip. NULL means English /
-- created before this existed.
alter table chat_escalations add column if not exists language text;
alter table chat_escalations add column if not exists question_english text;
