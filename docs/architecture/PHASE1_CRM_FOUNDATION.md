# Phase 1 Architecture — CRM Foundation

Status: **proposed, not yet built.** This is the design for Phase 1 of `docs/VISION.md`
— the shared database, roles, Approvals tab, and AI Activity audit log that every later
agent will plug into. No agent automation, no new customer-facing features ship in this
phase; it's infrastructure.

## Why this phase first

Every agent in the master vision writes to Approvals and AI Activity, reads from
Properties/Guests/Reservations/Knowledge Base, and gets gated by role-based
permissions. Building any agent before this exists means rebuilding it once the
foundation lands. This phase is invisible to you day-to-day but everything else depends
on it.

## What exists today vs. what changes

| Concern | Today | Phase 1 |
|---|---|---|
| CRM data (notes/tags, templates, sent-log) | Flat JSON files in `data/`; on Vercel these live in `/tmp` and don't reliably survive between requests (see `src/lib/store.ts`) | Postgres tables, durable |
| Pending AI drafts awaiting approval | Redis, 3-day TTL (`src/lib/pendingDrafts.ts`) | Folded into the new `approvals` table — a pending draft *is* an approval request, no need for two systems |
| Auth | One shared `DASHBOARD_PASSWORD` for anyone with the link (`src/app/api/login/route.ts`, `src/proxy.ts`) | Per-user accounts with roles (CEO, local manager, property manager, maintenance staff, marketing staff, accountant, bookkeeper, read-only) |
| Bookings/guests/properties | Fetched live from OwnerRez on every request, `unstable_cache`d | Unchanged — OwnerRez stays the source of truth for reservation data; Postgres does not duplicate it, it references it by ID |
| Audit trail | None — cron/webhook actions are only visible in Vercel's function logs | Append-only `ai_activity_log` table, no agent (or human, short of a DB admin) can edit/delete past entries |

**Deliberately NOT changing in Phase 1:** OwnerRez stays the reservation/guest/property
source of truth. We are not building a second copy of booking data — the new DB stores
CRM-specific state (notes, approvals, audit log, knowledge base, users/roles) and
references OwnerRez records by their OwnerRez IDs, the same pattern the app already
uses for guest notes today.

## Tech stack decision

- **Database: Postgres.** Either Vercel Postgres (Neon-backed, zero extra account,
  billed through Vercel) or Supabase (generous free tier, adds a second account/
  dashboard to manage). Either works fine at this scale — recommend **Vercel Postgres**
  purely to keep one less account/bill to manage, unless you want Supabase's nicer
  table-browsing UI for yourself. **This is a decision for you** — see questions below.
- **ORM: Prisma.** Type-safe schema, migrations as version-controlled files (satisfies
  your rule #24 requirement for DB migrations), works cleanly with Next.js API routes.
- **Auth: NextAuth (Auth.js) with credentials provider**, backed by the new `users`
  table (bcrypt-hashed passwords). Keeps everything self-hosted with no new external
  account needed, unlike Clerk/Auth0. 2FA (TOTP) added as a fast-follow once basic
  roles are working — flagged in your spec as a required control.
- **Redis stays** for what it's already good at (ephemeral translation cache, style-
  pool cache) — only the pending-drafts use case moves to Postgres since those are now
  permanent, auditable approval records, not throwaway cache entries.
- **No queue system yet.** The AI COO's task-queue *table* gets built now (so the data
  model exists), but real background-job orchestration (needed once multiple agents run
  concurrently) is deferred to Phase 3+ when there's more than one agent to coordinate.
  Vercel cron + the existing route-per-job pattern is enough for Phase 1–2's single
  Guest Experience Agent.

## Database schema (Phase 1 tables)

```
users
  id, email, password_hash, name, role, active, created_at, last_login_at

roles (seed data, not user-editable via UI yet)
  ceo | local_manager | property_manager | maintenance_staff | marketing_staff
  | accountant | bookkeeper | vendor | ai_agent | read_only

properties
  id, ownerrez_property_id, name, active, created_at
  -- seeded from OwnerRez's /v2/properties; one row per property, Legacy Colombia
  -- first, ready for the multi-property future the vision calls for

agents (registry, not yet driving live automation)
  id, key (e.g. "guest_experience"), display_name, description,
  mode (sandbox | shadow | approval | limited_auto | full_auto), active

approvals
  id, agent_id (fk -> agents), property_id (fk -> properties, nullable),
  type (e.g. "guest_reply", "discount", "refund", "bill_payment", ...),
  title, description, recommendation, alternatives (jsonb),
  financial_impact_cents, guest_impact, revenue_impact_cents, risk_level,
  confidence_score, deadline_at,
  status (pending | approved | rejected | modified | expired),
  decided_by (fk -> users, nullable), decided_at, decision_note,
  related_reservation_id, related_guest_id, related_vendor_id (nullable, text —
    OwnerRez/external IDs, not FKs, since those systems are external sources of truth),
  created_at, updated_at
  -- this table replaces pendingDrafts.ts's Redis store; a drafted guest reply
  -- awaiting WhatsApp approval becomes one row here with type = "guest_reply"

ai_activity_log (append-only — no UPDATE/DELETE grants for the app's DB role)
  id, occurred_at, agent_id (fk -> agents), task, trigger,
  data_reviewed (jsonb), decision, policy_used, confidence_score,
  action_taken, approval_id (fk -> approvals, nullable),
  communication_sent (jsonb, nullable), system_changed, result,
  error (nullable), reversed_at (nullable), human_override_by (fk -> users, nullable)

tasks (AI COO's queue — schema only in Phase 1, no live COO logic yet)
  id, title, assigned_agent_id (fk -> agents), priority, status,
  due_at, confidence_score, approval_required (bool), approval_id (fk, nullable),
  responsible_user_id (fk -> users, nullable), last_action, next_action,
  completed_at, created_at

knowledge_base_articles
  id, category, title, body_markdown, current (bool), superseded_by (fk, nullable),
  created_by (fk -> users), created_at, updated_at
  -- category enum mirrors your spec: property_facts, house_rules, check_in,
  -- checkout, emergency_contacts, vendor_contacts, pricing_policy, discount_policy,
  -- refund_policy, compensation_policy, maintenance_procedures, brand_voice,
  -- response_examples, local_recs, upsells, contracts, insurance,
  -- marketing_guidelines, seo_guidelines, bill_pay_policy, approval_thresholds, faq

approval_thresholds (configurable, replaces hardcoded env-var-style limits)
  id, key (e.g. "max_auto_discount_pct", "max_auto_refund_cents",
  "max_auto_rate_change_pct", "max_bill_auto_threshold_cents"), value, updated_by,
  updated_at
```

Guest notes/tags and message templates (currently `data/guests.json`,
`data/templates.json`) migrate into Postgres as `guest_notes` and `message_templates`
tables in the same pass — small, low-risk, and removes the last reason `store.ts`'s
"this doesn't survive on Vercel" caveat needs to exist.

## Roles & permissions (Phase 1 scope)

Full role matrix comes with each agent as it's built (a bookkeeper doesn't need
Marketing tab access, etc.) — Phase 1 just needs the roles to exist and gate the
**Approvals** and **AI Activity** tabs correctly:

- **CEO (you):** full access, only one who can edit `approval_thresholds`.
- **Local manager / property manager:** can view/act on Approvals for their assigned
  property; read-only on AI Activity.
- **Everyone else (maintenance staff, marketing staff, accountant, bookkeeper,
  vendor):** scoped in later phases when their tabs exist; Phase 1 just needs the
  `role` column to exist so this isn't a breaking migration later.
- **Read-only:** exactly what it says — useful for anyone you want to see the dashboard
  without being able to click anything.

## Approval framework — deterministic, not prompt-based

Per your rule #24 ("place critical approval rules in deterministic code, not only in AI
prompts"): thresholds live in the `approval_thresholds` table and are checked in plain
TypeScript before any agent action executes, e.g.:

```ts
if (discountPct > getThreshold("max_auto_discount_pct")) {
  return createApproval({ type: "discount", ... }); // blocks, does not proceed
}
```

An agent's LLM call can *recommend* exceeding a threshold, but the code path that would
execute the action checks the threshold independently — the AI cannot talk its way past
a limit by being convincing in its own output.

## Audit log design

- `ai_activity_log` rows are inserted by application code, never by the LLM directly
  (prevents a prompt-injected or malformed model response from writing false audit
  entries).
- The database role the app connects as has `INSERT`/`SELECT` but not `UPDATE`/`DELETE`
  on this table — enforced at the database level, not just in application code, so even
  a bug can't silently rewrite history.
- Every `approvals` decision (approve/reject/modify) writes a corresponding
  `ai_activity_log` row automatically.

## Migration plan

1. Provision Postgres (your decision — see questions below).
2. Prisma schema + first migration (tables above).
3. Port `data/guests.json` → `guest_notes`, `data/templates.json` →
   `message_templates` (one-time script, verified against current data before cutover).
4. Port Redis `pendingDrafts` → `approvals` (mapping `PendingDraft` fields onto the new
   schema — `isServiceRequest`/`guestPhone` etc. map directly).
5. Replace `src/lib/store.ts`'s JSON read/write with Prisma calls; keep the same
   function signatures so calling code (`GuestsExplorer.tsx`, `MessagingCenter.tsx`,
   etc.) doesn't need to change.
6. Add NextAuth, migrate the single `DASHBOARD_PASSWORD` gate to a `users` table with
   one seeded CEO account (you), keep the old password working during a short overlap
   window so you're never locked out mid-migration.
7. Build the Approvals and AI Activity pages (new CRM tabs) reading from the new
   tables. Rewire the existing WhatsApp-approval flow (`check-messages/route.ts`,
   `whatsapp/webhook/route.ts`) to write into `approvals` instead of Redis
   `pendingDrafts` — this is the first real proof the foundation works end-to-end,
   since it's automating something that already runs in production today.
8. Verify build, deploy, confirm a real guest-reply approval flows through WhatsApp →
   `approvals` table → AI Activity log correctly, side by side with the old path,
   before removing the old Redis-based code.

## Security notes specific to this phase

- DB connection string is a Vercel env var, never in code (already the pattern for
  every other secret in this project).
- Passwords hashed with bcrypt, never stored/logged in plaintext.
- Session cookies, httpOnly + secure, standard NextAuth defaults.
- No new external accounts hold financial or guest PII beyond what OwnerRez/WhatsApp
  already hold — the new DB stores CRM metadata, not a second copy of guest payment
  info.

## Testing plan for this phase

- Migration scripts run against a copy of production data in a scratch DB first,
  diffed against the JSON files for correctness, before touching the real one.
- Login/roles: verify a CEO account can access Approvals + AI Activity, and that the
  audit table genuinely rejects UPDATE/DELETE at the DB level (test with a raw SQL
  attempt, not just through the app).
- Approval flow: run one real guest-reply approval end-to-end after cutover, confirm it
  matches today's WhatsApp YES/NO/edit behavior exactly before decommissioning the
  Redis path.

## Deployment plan

Still Vercel, still `Publish Online.command` for code changes. Only addition: one new
env var (`DATABASE_URL`) set in Vercel's dashboard after you provision Postgres, same
pattern as every other credential in `.env.local.example`.

## Decisions needed from you before I start building

1. Vercel Postgres vs. Supabase for the database.
2. OK to do a short-lived dual-auth overlap (old password + new per-user login both
   work for a day or two during cutover) so there's no risk of being locked out?

## What Phase 1 explicitly does NOT include

No agent automation, no new guest-facing behavior, no Marketing/SEO/Revenue/Bill Pay
tabs yet (those are Phases 4–7). The one visible behavior change: the existing AI-draft
WhatsApp approval flow starts writing to the new `approvals`/`ai_activity_log` tables
instead of Redis — everything else about how it works for you day-to-day stays
identical.
