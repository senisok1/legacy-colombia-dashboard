-- Public AI chat widget (legacycolombia.com) — persistent escalation +
-- learned-answer store. Complements src/lib/chatWidget.ts (which never
-- writes anywhere on its own) and reuses the guest-reply approval pattern
-- already established elsewhere in this app (see 0008_reputation.sql,
-- pendingDrafts.ts): nothing is ever sent to a website visitor without
-- Seni's YES/NO/EDIT approval over WhatsApp first.
--
-- Lifecycle: a visitor's question the AI can't confidently answer creates a
-- 'pending' row here with an AI-drafted best-guess answer attached. Seni
-- approves (as-is or edited) or rejects over WhatsApp. Once answered, the
-- widget polls for the answer and shows it live if the visitor is still on
-- the page (delivered_via_widget); if they've left — either an explicit
-- page-close beacon (visitor_left_at) or simply 10+ minutes with no poll —
-- a fallback delivery goes out by email and/or WhatsApp instead. Answered
-- rows also double as a growing FAQ/knowledge base: chatWidget.ts's
-- answerVisitorQuestion() is grounded in the most recently answered
-- questions here so the AI can confidently self-answer similar future
-- questions instead of escalating every time.
--
-- Applied via GET /api/admin/migrate?secret=... (see project memory on why
-- DATABASE_URL can't be pulled into the build sandbox directly).

do $$ begin
  create type chat_escalation_status as enum (
    'pending',   -- awaiting Seni's YES/NO/EDIT decision
    'answered',  -- Seni approved (as-is or edited) — final_answer is set
    'rejected'   -- Seni said NO — nothing will be sent automatically
  );
exception when duplicate_object then null; end $$;

create table if not exists chat_escalations (
  id text primary key default gen_random_uuid()::text,
  question text not null,
  conversation_summary text,
  visitor_name text not null,
  visitor_email text,
  visitor_phone text,
  ai_draft_answer text,
  status chat_escalation_status not null default 'pending',
  final_answer text,
  wamid text, -- WhatsApp approval message id sent to Seni, for swipe-to-reply matching
  delivered_via_widget boolean not null default false,
  visitor_left_at timestamptz, -- page-unload beacon, lets fallback fire before the 10-min timeout
  fallback_sent_at timestamptz,
  fallback_channel text, -- 'email' | 'whatsapp' | 'email+whatsapp'
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists chat_escalations_status_idx on chat_escalations (status);
create index if not exists chat_escalations_created_idx on chat_escalations (created_at desc);
create index if not exists chat_escalations_wamid_idx on chat_escalations (wamid);
