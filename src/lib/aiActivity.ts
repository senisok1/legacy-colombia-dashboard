import { query, queryOne } from "./db";
import { isDbConfigured } from "./config";
import { getDefaultOrganizationId } from "./organizations";

// Append-only AI activity audit log — see docs/architecture/PHASE1_CRM_FOUNDATION.md
// and db/migrations/0001_init.sql's ai_activity_log table. This is the ONLY
// place in the codebase that writes to that table, and it only ever INSERTs
// — no function here updates or deletes a row, which (alongside the
// database role's own privileges, a future hardening step) is what keeps
// the log append-only in practice.
//
// Deliberately fail-safe: every call is wrapped so a logging failure (DB not
// configured yet, a transient connection error, etc.) can NEVER break the
// actual guest-reply/WhatsApp-approval pipeline this is observing. Logging
// is additive — it should be invisible when it works and invisible when it
// doesn't.

// Phase 3: agents.key used to be globally unique; migration 0015 widened
// that to unique-per-(organization_id, key) since two tenants independently
// running "revenue_manager", "guest_experience", etc. shouldn't collide or
// share settings. The cache key and the ON CONFLICT target both have to
// match that composite uniqueness now, or agent-id lookups silently
// cross-contaminate between tenants (or, for a brand-new key, the INSERT's
// ON CONFLICT (key) would error outright since there's no longer a
// single-column unique constraint to target).
const agentIdCache = new Map<string, string>();

async function getOrCreateAgentId(key: string, displayName: string, organizationId: string): Promise<string | null> {
  const cacheKey = `${organizationId}:${key}`;
  const cached = agentIdCache.get(cacheKey);
  if (cached) return cached;
  const existing = await queryOne<{ id: string }>("select id from agents where organization_id = $1 and key = $2", [
    organizationId,
    key,
  ]);
  if (existing) {
    agentIdCache.set(cacheKey, existing.id);
    return existing.id;
  }
  const created = await queryOne<{ id: string }>(
    `insert into agents (organization_id, key, display_name) values ($1, $2, $3)
     on conflict (organization_id, key) do update set display_name = excluded.display_name
     returning id`,
    [organizationId, key, displayName]
  );
  if (created) agentIdCache.set(cacheKey, created.id);
  return created?.id ?? null;
}

export type LogAiActivityInput = {
  agentKey: string;
  agentDisplayName: string;
  task: string;
  trigger?: string;
  dataReviewed?: unknown;
  decision?: string;
  policyUsed?: string;
  confidenceScore?: number;
  actionTaken?: string;
  communicationSent?: unknown;
  systemChanged?: string;
  result?: string;
  error?: string;
};

export async function logAiActivity(input: LogAiActivityInput, organizationId?: string): Promise<void> {
  if (!isDbConfigured()) return; // Nothing to log to yet — silently skip, don't block callers.
  try {
    const orgId = organizationId ?? (await getDefaultOrganizationId());
    const agentId = await getOrCreateAgentId(input.agentKey, input.agentDisplayName, orgId);
    await query(
      `insert into ai_activity_log
         (organization_id, agent_id, task, trigger, data_reviewed, decision, policy_used, confidence_score,
          action_taken, communication_sent, system_changed, result, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        orgId,
        agentId,
        input.task,
        input.trigger ?? null,
        input.dataReviewed !== undefined ? JSON.stringify(input.dataReviewed) : null,
        input.decision ?? null,
        input.policyUsed ?? null,
        input.confidenceScore ?? null,
        input.actionTaken ?? null,
        input.communicationSent !== undefined ? JSON.stringify(input.communicationSent) : null,
        input.systemChanged ?? null,
        input.result ?? null,
        input.error ?? null,
      ]
    );
  } catch (err) {
    // Never let a logging failure take down the pipeline it's observing.
    console.error("[aiActivity] failed to record log entry (non-fatal)", err);
  }
}

export type AiActivityEntry = {
  id: string;
  occurredAt: string;
  agentName: string | null;
  task: string;
  trigger: string | null;
  dataReviewed: unknown;
  decision: string | null;
  policyUsed: string | null;
  confidenceScore: number | null;
  actionTaken: string | null;
  communicationSent: unknown;
  systemChanged: string | null;
  result: string | null;
  error: string | null;
};

type ActivityRow = {
  id: string;
  occurred_at: string;
  agent_name: string | null;
  task: string;
  trigger: string | null;
  data_reviewed: unknown;
  decision: string | null;
  policy_used: string | null;
  confidence_score: number | null;
  action_taken: string | null;
  communication_sent: unknown;
  system_changed: string | null;
  result: string | null;
  error: string | null;
};

/** Most recent entries from the append-only audit log, newest first —
 * powers the AI Activity tab (app/activity/page.tsx). Read-only: this file
 * never issues an UPDATE/DELETE against ai_activity_log, see the note up
 * top. Returns an empty list (rather than throwing) when the database isn't
 * configured yet, same fail-open philosophy as logAiActivity above. */
export async function getRecentAiActivity(limit = 100, organizationId?: string): Promise<AiActivityEntry[]> {
  if (!isDbConfigured()) return [];
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<ActivityRow>(
    `select l.id, l.occurred_at, a.display_name as agent_name, l.task, l.trigger, l.data_reviewed,
            l.decision, l.policy_used, l.confidence_score, l.action_taken, l.communication_sent,
            l.system_changed, l.result, l.error
     from ai_activity_log l
     left join agents a on a.id = l.agent_id
     where l.organization_id = $2
     order by l.occurred_at desc
     limit $1`,
    [limit, orgId]
  );
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    agentName: r.agent_name,
    task: r.task,
    trigger: r.trigger,
    dataReviewed: r.data_reviewed,
    decision: r.decision,
    policyUsed: r.policy_used,
    confidenceScore: r.confidence_score,
    actionTaken: r.action_taken,
    communicationSent: r.communication_sent,
    systemChanged: r.system_changed,
    result: r.result,
    error: r.error,
  }));
}
