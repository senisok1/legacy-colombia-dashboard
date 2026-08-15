import { query, queryOne } from "./db";
import { getDefaultOrganizationId } from "./organizations";
import type { ChatEscalation } from "./types";

// Data layer for the public chat widget's escalation/approval flow — see
// db/migrations/0011_chat_widget.sql and the header comment there for the
// full lifecycle. Mirrors lib/reputationManager.ts's plain-SQL style (this
// app deliberately avoids an ORM — see db/migrations/0001_init.sql).

type ChatEscalationRow = {
  id: string;
  question: string;
  conversation_summary: string | null;
  visitor_name: string;
  visitor_email: string | null;
  visitor_phone: string | null;
  ai_draft_answer: string | null;
  status: ChatEscalation["status"];
  final_answer: string | null;
  wamid: string | null;
  delivered_via_widget: boolean;
  visitor_left_at: string | null;
  fallback_sent_at: string | null;
  fallback_channel: string | null;
  source: ChatEscalation["source"];
  created_at: string;
  answered_at: string | null;
};

function fromRow(row: ChatEscalationRow): ChatEscalation {
  return {
    id: row.id,
    question: row.question,
    conversationSummary: row.conversation_summary ?? undefined,
    visitorName: row.visitor_name,
    visitorEmail: row.visitor_email ?? undefined,
    visitorPhone: row.visitor_phone ?? undefined,
    source: row.source ?? "website",
    aiDraftAnswer: row.ai_draft_answer ?? undefined,
    status: row.status,
    finalAnswer: row.final_answer ?? undefined,
    wamid: row.wamid ?? undefined,
    deliveredViaWidget: row.delivered_via_widget,
    visitorLeftAt: row.visitor_left_at ?? undefined,
    fallbackSentAt: row.fallback_sent_at ?? undefined,
    fallbackChannel: row.fallback_channel ?? undefined,
    createdAt: row.created_at,
    answeredAt: row.answered_at ?? undefined,
  };
}

export async function createChatEscalation(
  input: {
    question: string;
    conversationSummary?: string;
    visitorName: string;
    visitorEmail?: string;
    visitorPhone?: string;
    aiDraftAnswer?: string;
    /** Defaults to "website" — see ChatEscalationSource in lib/types.ts. */
    source?: ChatEscalation["source"];
  },
  organizationId?: string
): Promise<ChatEscalation> {
  // NOTE: which tenant's widget a given visitor is on isn't resolved yet
  // (that needs a widget-key/domain routing layer that doesn't exist yet) —
  // callers today invoke this with no organizationId, so it falls back to
  // the single default org exactly as before.
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ChatEscalationRow>(
    `insert into chat_escalations
       (organization_id, question, conversation_summary, visitor_name, visitor_email, visitor_phone, ai_draft_answer, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      orgId,
      input.question,
      input.conversationSummary ?? null,
      input.visitorName,
      input.visitorEmail ?? null,
      input.visitorPhone ?? null,
      input.aiDraftAnswer ?? null,
      input.source ?? "website",
    ]
  );
  if (!row) throw new Error("Insert into chat_escalations returned no row.");
  return fromRow(row);
}

export async function getChatEscalation(id: string, organizationId?: string): Promise<ChatEscalation | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ChatEscalationRow>(
    "select * from chat_escalations where id = $1 and organization_id = $2",
    [id, orgId]
  );
  return row ? fromRow(row) : null;
}

export async function getChatEscalationByWamid(
  wamid: string,
  organizationId?: string
): Promise<ChatEscalation | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ChatEscalationRow>(
    "select * from chat_escalations where wamid = $1 and organization_id = $2",
    [wamid, orgId]
  );
  return row ? fromRow(row) : null;
}

/** The single oldest escalation still awaiting Seni's decision — fallback
 * when a WhatsApp reply doesn't quote/reference a specific approval
 * message, same convention as pendingDrafts.ts's getOldestPendingDraft. */
export async function getOldestPendingChatEscalation(organizationId?: string): Promise<ChatEscalation | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ChatEscalationRow>(
    `select * from chat_escalations where status = 'pending' and organization_id = $1 order by created_at asc limit 1`,
    [orgId]
  );
  return row ? fromRow(row) : null;
}

export async function linkChatEscalationWamid(id: string, wamid: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await query("update chat_escalations set wamid = $1 where id = $2 and organization_id = $3", [wamid, id, orgId]);
}

/** The oldest still-pending WhatsApp-sourced inquiry from a given number, if
 * any — lets the webhook avoid creating a duplicate escalation (and paging
 * Seni again) for every follow-up message a visitor sends while waiting on
 * an answer to their first one. See db/migrations/0012_whatsapp_inquiries.sql's
 * partial index backing this lookup. */
export async function getPendingWhatsAppEscalationByPhone(
  phone: string,
  organizationId?: string
): Promise<ChatEscalation | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ChatEscalationRow>(
    `select * from chat_escalations
     where source = 'whatsapp' and status = 'pending' and visitor_phone = $1 and organization_id = $2
     order by created_at asc
     limit 1`,
    [phone, orgId]
  );
  return row ? fromRow(row) : null;
}

export async function resolveChatEscalation(
  id: string,
  update: { status: "answered" | "rejected"; finalAnswer?: string },
  organizationId?: string
): Promise<ChatEscalation | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<ChatEscalationRow>(
    `update chat_escalations
       set status = $2, final_answer = $3, answered_at = now()
     where id = $1 and organization_id = $4
     returning *`,
    [id, update.status, update.finalAnswer ?? null, orgId]
  );
  return row ? fromRow(row) : null;
}

/** Called the moment the widget's poll endpoint actually hands the answer
 * back to a still-open browser tab. Uses an atomic UPDATE ... WHERE guard
 * (rather than a separate read-then-write) so, in the unlikely case the
 * fallback sweep and a poll race each other, only one of them "wins" and
 * fires a delivery. Returns true only for the caller that made the change —
 * a second call (e.g. the widget's own retry) safely returns false without
 * re-marking anything. */
export async function markDeliveredViaWidget(id: string, organizationId?: string): Promise<boolean> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<{ id: string }>(
    `update chat_escalations
       set delivered_via_widget = true
     where id = $1 and delivered_via_widget = false and organization_id = $2
     returning id`,
    [id, orgId]
  );
  return Boolean(row);
}

/** Marks that the visitor's browser tab is gone (page-unload beacon) — lets
 * the fallback sweep fire immediately instead of waiting out the full
 * timeout. Best-effort by nature (sendBeacon can't guarantee delivery), so
 * the timeout-based check in getChatEscalationsNeedingFallback stays as the
 * backstop for whenever this doesn't fire. */
export async function markVisitorLeft(id: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await query(
    `update chat_escalations set visitor_left_at = now() where id = $1 and visitor_left_at is null and organization_id = $2`,
    [id, orgId]
  );
}

/** Answered escalations that still need a fallback delivery: Seni has
 * approved/edited an answer, the widget never picked it up live, no
 * fallback has gone out yet, and either the visitor explicitly left
 * (visitor_left_at) or enough time has passed (staleMinutes) that they
 * almost certainly have. Used by the check-messages cron's fallback sweep —
 * see api/cron/check-messages/route.ts. */
export async function getChatEscalationsNeedingFallback(
  staleMinutes: number,
  organizationId?: string
): Promise<ChatEscalation[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<ChatEscalationRow>(
    `select * from chat_escalations
     where status = 'answered'
       and delivered_via_widget = false
       and fallback_sent_at is null
       and (visitor_left_at is not null or created_at < now() - ($1 || ' minutes')::interval)
       and organization_id = $2
     order by created_at asc`,
    [staleMinutes, orgId]
  );
  return rows.map(fromRow);
}

export async function markFallbackSent(id: string, channel: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await query(
    `update chat_escalations set fallback_sent_at = now(), fallback_channel = $2 where id = $1 and organization_id = $3`,
    [id, channel, orgId]
  );
}

/** Most recently answered questions, newest first — grounds
 * lib/chatWidget.ts's answerVisitorQuestion() so a question that's already
 * been through human review can be confidently self-answered next time
 * instead of escalating again. */
export async function getRecentAnsweredEscalations(
  limit: number,
  organizationId?: string
): Promise<{ question: string; answer: string }[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<{ question: string; final_answer: string }>(
    `select question, final_answer from chat_escalations
     where status = 'answered' and final_answer is not null and organization_id = $2
     order by answered_at desc
     limit $1`,
    [limit, orgId]
  );
  return rows.map((r) => ({ question: r.question, answer: r.final_answer }));
}
