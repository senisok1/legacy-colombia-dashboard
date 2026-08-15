-- Introduces organizations (tenants) so this CRM can be sold as a
-- subscription product to multiple property-management companies instead
-- of assuming one single global OwnerRez/WhatsApp/PriceLabs account for the
-- whole deployment. Approach: shared database, every table gets an
-- organization_id column, every query gets scoped by it (see
-- docs/architecture/ for the full multi-tenancy plan).
--
-- This migration is purely additive/backfilling — it does not change any
-- application behavior yet. Every existing row across every table is
-- backfilled onto one organization ("Legacy Estate Rentals", the current
-- customer), so the live app keeps working exactly as before. Later
-- migrations/phases teach the application code to actually read
-- organization_id from the logged-in user's session instead of assuming
-- there's only ever one tenant.
--
-- A few existing unique constraints were only safe because there was one
-- OwnerRez account in the whole database (e.g. properties.ownerrez_property_id
-- unique, agents.key unique, guest_notes.guest_id unique). Those get
-- widened to be unique *per organization* here, since two different
-- customers' OwnerRez accounts can otherwise reuse the same numeric IDs.

create table if not exists organizations (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  slug text unique not null,
  plan text not null default 'trial',
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text not null default 'trialing',
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists organizations_stripe_customer_id_idx on organizations(stripe_customer_id);

do $$
declare
  org_id text;
begin
  select id into org_id from organizations where slug = 'legacy-estate-rentals';
  if org_id is null then
    insert into organizations (name, slug, plan, subscription_status)
    values ('Legacy Estate Rentals', 'legacy-estate-rentals', 'pro', 'active')
    returning id into org_id;
  end if;

  -- users
  if not exists (select 1 from information_schema.columns where table_name = 'users' and column_name = 'organization_id') then
    alter table users add column organization_id text references organizations(id);
    update users set organization_id = org_id where organization_id is null;
    alter table users alter column organization_id set not null;
  end if;

  -- properties: ownerrez_property_id was globally unique; two different
  -- customers' OwnerRez accounts can have overlapping numeric IDs, so this
  -- must become unique per-org.
  if not exists (select 1 from information_schema.columns where table_name = 'properties' and column_name = 'organization_id') then
    alter table properties add column organization_id text references organizations(id);
    update properties set organization_id = org_id where organization_id is null;
    alter table properties alter column organization_id set not null;
    alter table properties drop constraint if exists properties_ownerrez_property_id_key;
    create unique index if not exists properties_org_ownerrez_id_idx on properties(organization_id, ownerrez_property_id);
  end if;

  -- agents: key ('revenue_manager', 'reputation_manager', ...) was globally
  -- unique; every new tenant needs their own row per agent key so each
  -- tenant can independently control that agent's mode.
  if not exists (select 1 from information_schema.columns where table_name = 'agents' and column_name = 'organization_id') then
    alter table agents add column organization_id text references organizations(id);
    update agents set organization_id = org_id where organization_id is null;
    alter table agents alter column organization_id set not null;
    alter table agents drop constraint if exists agents_key_key;
    create unique index if not exists agents_org_key_idx on agents(organization_id, key);
  end if;

  -- approvals
  if not exists (select 1 from information_schema.columns where table_name = 'approvals' and column_name = 'organization_id') then
    alter table approvals add column organization_id text references organizations(id);
    update approvals set organization_id = org_id where organization_id is null;
    alter table approvals alter column organization_id set not null;
  end if;

  -- ai_activity_log
  if not exists (select 1 from information_schema.columns where table_name = 'ai_activity_log' and column_name = 'organization_id') then
    alter table ai_activity_log add column organization_id text references organizations(id);
    update ai_activity_log set organization_id = org_id where organization_id is null;
    alter table ai_activity_log alter column organization_id set not null;
  end if;

  -- tasks
  if not exists (select 1 from information_schema.columns where table_name = 'tasks' and column_name = 'organization_id') then
    alter table tasks add column organization_id text references organizations(id);
    update tasks set organization_id = org_id where organization_id is null;
    alter table tasks alter column organization_id set not null;
  end if;

  -- knowledge_base_articles
  if not exists (select 1 from information_schema.columns where table_name = 'knowledge_base_articles' and column_name = 'organization_id') then
    alter table knowledge_base_articles add column organization_id text references organizations(id);
    update knowledge_base_articles set organization_id = org_id where organization_id is null;
    alter table knowledge_base_articles alter column organization_id set not null;
  end if;

  -- approval_thresholds: key was globally unique, needs to become per-org
  if not exists (select 1 from information_schema.columns where table_name = 'approval_thresholds' and column_name = 'organization_id') then
    alter table approval_thresholds add column organization_id text references organizations(id);
    update approval_thresholds set organization_id = org_id where organization_id is null;
    alter table approval_thresholds alter column organization_id set not null;
    alter table approval_thresholds drop constraint if exists approval_thresholds_key_key;
    create unique index if not exists approval_thresholds_org_key_idx on approval_thresholds(organization_id, key);
  end if;

  -- guest_notes: guest_id was globally unique; OwnerRez guest IDs are only
  -- unique within one OwnerRez account, so this becomes unique per-org.
  if not exists (select 1 from information_schema.columns where table_name = 'guest_notes' and column_name = 'organization_id') then
    alter table guest_notes add column organization_id text references organizations(id);
    update guest_notes set organization_id = org_id where organization_id is null;
    alter table guest_notes alter column organization_id set not null;
    alter table guest_notes drop constraint if exists guest_notes_guest_id_key;
    create unique index if not exists guest_notes_org_guest_idx on guest_notes(organization_id, guest_id);
  end if;

  -- message_templates
  if not exists (select 1 from information_schema.columns where table_name = 'message_templates' and column_name = 'organization_id') then
    alter table message_templates add column organization_id text references organizations(id);
    update message_templates set organization_id = org_id where organization_id is null;
    alter table message_templates alter column organization_id set not null;
  end if;

  -- message_log
  if not exists (select 1 from information_schema.columns where table_name = 'message_log' and column_name = 'organization_id') then
    alter table message_log add column organization_id text references organizations(id);
    update message_log set organization_id = org_id where organization_id is null;
    alter table message_log alter column organization_id set not null;
  end if;

  -- vendors
  if not exists (select 1 from information_schema.columns where table_name = 'vendors' and column_name = 'organization_id') then
    alter table vendors add column organization_id text references organizations(id);
    update vendors set organization_id = org_id where organization_id is null;
    alter table vendors alter column organization_id set not null;
  end if;

  -- bills
  if not exists (select 1 from information_schema.columns where table_name = 'bills' and column_name = 'organization_id') then
    alter table bills add column organization_id text references organizations(id);
    update bills set organization_id = org_id where organization_id is null;
    alter table bills alter column organization_id set not null;
  end if;

  -- rate_snapshots
  if not exists (select 1 from information_schema.columns where table_name = 'rate_snapshots' and column_name = 'organization_id') then
    alter table rate_snapshots add column organization_id text references organizations(id);
    update rate_snapshots set organization_id = org_id where organization_id is null;
    alter table rate_snapshots alter column organization_id set not null;
  end if;

  -- leads
  if not exists (select 1 from information_schema.columns where table_name = 'leads' and column_name = 'organization_id') then
    alter table leads add column organization_id text references organizations(id);
    update leads set organization_id = org_id where organization_id is null;
    alter table leads alter column organization_id set not null;
  end if;

  -- lifecycle_campaign_candidates
  if not exists (select 1 from information_schema.columns where table_name = 'lifecycle_campaign_candidates' and column_name = 'organization_id') then
    alter table lifecycle_campaign_candidates add column organization_id text references organizations(id);
    update lifecycle_campaign_candidates set organization_id = org_id where organization_id is null;
    alter table lifecycle_campaign_candidates alter column organization_id set not null;
  end if;

  -- guest_marketing_preferences: primary key was guest_id alone, must
  -- become (organization_id, guest_id) for the same cross-tenant-collision
  -- reason as guest_notes above.
  if not exists (select 1 from information_schema.columns where table_name = 'guest_marketing_preferences' and column_name = 'organization_id') then
    alter table guest_marketing_preferences add column organization_id text references organizations(id);
    update guest_marketing_preferences set organization_id = org_id where organization_id is null;
    alter table guest_marketing_preferences alter column organization_id set not null;
    alter table guest_marketing_preferences drop constraint if exists guest_marketing_preferences_pkey;
    alter table guest_marketing_preferences add primary key (organization_id, guest_id);
  end if;

  -- content_pieces
  if not exists (select 1 from information_schema.columns where table_name = 'content_pieces' and column_name = 'organization_id') then
    alter table content_pieces add column organization_id text references organizations(id);
    update content_pieces set organization_id = org_id where organization_id is null;
    alter table content_pieces alter column organization_id set not null;
  end if;

  -- work_orders
  if not exists (select 1 from information_schema.columns where table_name = 'work_orders' and column_name = 'organization_id') then
    alter table work_orders add column organization_id text references organizations(id);
    update work_orders set organization_id = org_id where organization_id is null;
    alter table work_orders alter column organization_id set not null;
  end if;

  -- reputation_responses
  if not exists (select 1 from information_schema.columns where table_name = 'reputation_responses' and column_name = 'organization_id') then
    alter table reputation_responses add column organization_id text references organizations(id);
    update reputation_responses set organization_id = org_id where organization_id is null;
    alter table reputation_responses alter column organization_id set not null;
  end if;

  -- rate_overrides
  if not exists (select 1 from information_schema.columns where table_name = 'rate_overrides' and column_name = 'organization_id') then
    alter table rate_overrides add column organization_id text references organizations(id);
    update rate_overrides set organization_id = org_id where organization_id is null;
    alter table rate_overrides alter column organization_id set not null;
  end if;

  -- marketing_contacts: email was globally unique, needs to become
  -- per-org (two tenants may both have a contact with the same email).
  if not exists (select 1 from information_schema.columns where table_name = 'marketing_contacts' and column_name = 'organization_id') then
    alter table marketing_contacts add column organization_id text references organizations(id);
    update marketing_contacts set organization_id = org_id where organization_id is null;
    alter table marketing_contacts alter column organization_id set not null;
    alter table marketing_contacts drop constraint if exists marketing_contacts_email_key;
    create unique index if not exists marketing_contacts_org_email_idx on marketing_contacts(organization_id, email);
  end if;

  -- chat_escalations: public chat-widget submissions, tied to whichever
  -- tenant's website widget the visitor was using.
  if not exists (select 1 from information_schema.columns where table_name = 'chat_escalations' and column_name = 'organization_id') then
    alter table chat_escalations add column organization_id text references organizations(id);
    update chat_escalations set organization_id = org_id where organization_id is null;
    alter table chat_escalations alter column organization_id set not null;
  end if;
end $$;

create index if not exists users_organization_id_idx on users(organization_id);
create index if not exists properties_organization_id_idx on properties(organization_id);
create index if not exists agents_organization_id_idx on agents(organization_id);
create index if not exists approvals_organization_id_idx on approvals(organization_id);
create index if not exists ai_activity_log_organization_id_idx on ai_activity_log(organization_id);
create index if not exists tasks_organization_id_idx on tasks(organization_id);
create index if not exists knowledge_base_articles_organization_id_idx on knowledge_base_articles(organization_id);
create index if not exists approval_thresholds_organization_id_idx on approval_thresholds(organization_id);
create index if not exists guest_notes_organization_id_idx on guest_notes(organization_id);
create index if not exists message_templates_organization_id_idx on message_templates(organization_id);
create index if not exists message_log_organization_id_idx on message_log(organization_id);
create index if not exists vendors_organization_id_idx on vendors(organization_id);
create index if not exists bills_organization_id_idx on bills(organization_id);
create index if not exists rate_snapshots_organization_id_idx on rate_snapshots(organization_id);
create index if not exists leads_organization_id_idx on leads(organization_id);
create index if not exists lifecycle_campaign_candidates_organization_id_idx on lifecycle_campaign_candidates(organization_id);
create index if not exists content_pieces_organization_id_idx on content_pieces(organization_id);
create index if not exists work_orders_organization_id_idx on work_orders(organization_id);
create index if not exists reputation_responses_organization_id_idx on reputation_responses(organization_id);
create index if not exists rate_overrides_organization_id_idx on rate_overrides(organization_id);
create index if not exists marketing_contacts_organization_id_idx on marketing_contacts(organization_id);
create index if not exists chat_escalations_organization_id_idx on chat_escalations(organization_id);
