-- Phase 1 CRM foundation — see docs/architecture/PHASE1_CRM_FOUNDATION.md.
--
-- Note on tooling: the original plan called for Prisma, but this project's
-- build sandbox can't reach Prisma's engine-binary CDN (network allowlist)
-- and can't be handed the real DATABASE_URL at all (it's scrubbed before
-- reaching the sandbox — a deliberate safety measure so the agent never
-- holds raw production credentials). So this migration is plain SQL, applied
-- by scripts/migrate.mjs, which only ever runs on Seni's own machine or on
-- Vercel itself — both have the real, unscrubbed secret; the sandbox never
-- does. Everything else about the design (tables, relationships, the
-- append-only audit log) is unchanged from the original plan.
--
-- Applied via: npm run db:migrate (see scripts/migrate.mjs)

create table if not exists _migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

do $$ begin
  create type role as enum (
    'CEO', 'LOCAL_MANAGER', 'PROPERTY_MANAGER', 'MAINTENANCE_STAFF',
    'MARKETING_STAFF', 'ACCOUNTANT', 'BOOKKEEPER', 'VENDOR', 'AI_AGENT', 'READ_ONLY'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type agent_mode as enum ('SANDBOX', 'SHADOW', 'APPROVAL', 'LIMITED_AUTO', 'FULL_AUTO');
exception when duplicate_object then null; end $$;

do $$ begin
  create type approval_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'MODIFIED', 'EXPIRED');
exception when duplicate_object then null; end $$;

create table if not exists users (
  id text primary key default gen_random_uuid()::text,
  email text unique not null,
  password_hash text not null,
  name text,
  role role not null default 'READ_ONLY',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists properties (
  id text primary key default gen_random_uuid()::text,
  ownerrez_property_id integer unique not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists agents (
  id text primary key default gen_random_uuid()::text,
  key text unique not null,
  display_name text not null,
  description text,
  mode agent_mode not null default 'SANDBOX',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approvals (
  id text primary key default gen_random_uuid()::text,
  agent_id text references agents(id),
  property_id text references properties(id),
  type text not null,
  title text not null,
  description text,
  recommendation text,
  alternatives jsonb,
  financial_impact_cents integer,
  guest_impact text,
  revenue_impact_cents integer,
  risk_level text,
  confidence_score real,
  deadline_at timestamptz,
  status approval_status not null default 'PENDING',
  decided_by_id text references users(id),
  decided_at timestamptz,
  decision_note text,
  related_reservation_id text,
  related_guest_id text,
  related_vendor_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists approvals_status_idx on approvals(status);
create index if not exists approvals_agent_id_idx on approvals(agent_id);

-- Append-only. Application code only ever INSERTs here (see
-- src/lib/aiActivity.ts) — no UPDATE/DELETE call is written anywhere in the
-- codebase. True DB-level enforcement (a separate, more restricted role that
-- the app connects as, with UPDATE/DELETE revoked) is a follow-up hardening
-- step once Neon's free-tier role setup allows a second limited role.
create table if not exists ai_activity_log (
  id text primary key default gen_random_uuid()::text,
  occurred_at timestamptz not null default now(),
  agent_id text references agents(id),
  task text not null,
  trigger text,
  data_reviewed jsonb,
  decision text,
  policy_used text,
  confidence_score real,
  action_taken text,
  approval_id text references approvals(id),
  communication_sent jsonb,
  system_changed text,
  result text,
  error text,
  reversed_at timestamptz,
  human_override_by_id text references users(id)
);
create index if not exists ai_activity_log_occurred_at_idx on ai_activity_log(occurred_at desc);
create index if not exists ai_activity_log_agent_id_idx on ai_activity_log(agent_id);

create table if not exists tasks (
  id text primary key default gen_random_uuid()::text,
  title text not null,
  assigned_agent_id text references agents(id),
  priority text,
  status text not null default 'pending',
  due_at timestamptz,
  confidence_score real,
  approval_required boolean not null default false,
  approval_id text references approvals(id),
  responsible_user_id text references users(id),
  last_action text,
  next_action text,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists knowledge_base_articles (
  id text primary key default gen_random_uuid()::text,
  category text not null,
  title text not null,
  body_markdown text not null,
  current boolean not null default true,
  superseded_by_id text unique references knowledge_base_articles(id),
  created_by_id text references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approval_thresholds (
  id text primary key default gen_random_uuid()::text,
  key text unique not null,
  value double precision not null,
  updated_by_id text references users(id),
  updated_at timestamptz not null default now()
);

-- ---- CRM extension data, migrated off flat JSON files (src/lib/store.ts) ----

create table if not exists guest_notes (
  id text primary key default gen_random_uuid()::text,
  guest_id integer unique not null,
  notes text not null default '',
  tags text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists message_templates (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  trigger text not null,
  days_offset integer not null default 0,
  subject text not null,
  body_en text not null,
  body_es text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists message_log (
  id text primary key default gen_random_uuid()::text,
  booking_id integer not null,
  guest_id integer,
  guest_name text,
  template_id text,
  template_name text,
  language text not null,
  subject text not null,
  body text not null,
  status text not null,
  created_at timestamptz not null default now()
);
