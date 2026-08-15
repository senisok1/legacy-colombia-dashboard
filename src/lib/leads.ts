import { query, queryOne } from "./db";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import type { Lead, LeadStage } from "./types";

// Phase 6 of the Legacy AI Company roadmap (docs/VISION.md) — Sales Pipeline
// half of "Sales + CRM lifecycle marketing". Tracking/prioritization only:
// nothing in this file sends a guest-facing message, promises a date, or
// applies a discount — see db/migrations/0004_sales_pipeline.sql's header
// comment. A future Sales Agent can write to this same table once VISION.md's
// approval-gated automation for it is actually built; for now it's a manual
// board Seni works from.

const AGENT_KEY = "sales";
const AGENT_NAME = "AI Sales Agent";

type LeadRow = {
  id: string;
  guest_id: number | null;
  booking_id: number | null;
  property_id: string | null;
  guest_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  source: string;
  stage: LeadStage;
  desired_arrival: string | null;
  desired_departure: string | null;
  party_size: number | null;
  estimated_value_cents: number | null;
  notes: string | null;
  next_action: string | null;
  next_action_due_at: Date | null;
  last_contacted_at: Date | null;
  lost_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

function fromLeadRow(row: LeadRow): Lead {
  return {
    id: row.id,
    guestId: row.guest_id ?? undefined,
    bookingId: row.booking_id ?? undefined,
    propertyId: row.property_id ?? undefined,
    guestName: row.guest_name,
    contactEmail: row.contact_email ?? undefined,
    contactPhone: row.contact_phone ?? undefined,
    source: row.source,
    stage: row.stage,
    desiredArrival: row.desired_arrival ?? undefined,
    desiredDeparture: row.desired_departure ?? undefined,
    partySize: row.party_size ?? undefined,
    estimatedValueCents: row.estimated_value_cents ?? undefined,
    notes: row.notes ?? undefined,
    nextAction: row.next_action ?? undefined,
    nextActionDueAt: row.next_action_due_at ? row.next_action_due_at.toISOString() : undefined,
    lastContactedAt: row.last_contacted_at ? row.last_contacted_at.toISOString() : undefined,
    lostReason: row.lost_reason ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Every lead, newest first — the Sales Pipeline tab groups these by stage
 * client-side rather than needing separate queries per stage. */
export async function listLeads(organizationId?: string): Promise<Lead[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<LeadRow>("select * from leads where organization_id = $1 order by created_at desc", [
    orgId,
  ]);
  return rows.map(fromLeadRow);
}

export async function getLead(id: string, organizationId?: string): Promise<Lead | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<LeadRow>("select * from leads where id = $1 and organization_id = $2", [id, orgId]);
  return row ? fromLeadRow(row) : null;
}

export async function createLead(input: {
  guestId?: number;
  bookingId?: number;
  propertyId?: string;
  guestName: string;
  contactEmail?: string;
  contactPhone?: string;
  source?: string;
  desiredArrival?: string;
  desiredDeparture?: string;
  partySize?: number;
  estimatedValueCents?: number;
  notes?: string;
  nextAction?: string;
  nextActionDueAt?: string;
}, organizationId?: string): Promise<Lead> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<LeadRow>(
    `insert into leads
       (organization_id, guest_id, booking_id, property_id, guest_name, contact_email, contact_phone, source,
        desired_arrival, desired_departure, party_size, estimated_value_cents, notes,
        next_action, next_action_due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning *`,
    [
      orgId,
      input.guestId ?? null,
      input.bookingId ?? null,
      input.propertyId ?? null,
      input.guestName,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
      input.source ?? "manual",
      input.desiredArrival ?? null,
      input.desiredDeparture ?? null,
      input.partySize ?? null,
      input.estimatedValueCents ?? null,
      input.notes ?? null,
      input.nextAction ?? null,
      input.nextActionDueAt ?? null,
    ]
  );
  if (!row) throw new Error("Failed to create lead.");
  const lead = fromLeadRow(row);

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Log new lead",
    trigger: `New inquiry from ${lead.guestName} (source: ${lead.source})`,
    decision: "queued in pipeline at stage 'new'",
    actionTaken: "Created lead record",
    result: "new",
  }).catch(() => {});

  return lead;
}

/** Moves a lead to a new stage — the entire "sales decision" surface here.
 * `lostReason` is only stored when moving to 'lost'; it's cleared if a lead
 * is ever moved back out of 'lost' so an old reason doesn't linger and look
 * current. */
export async function updateLeadStage(
  id: string,
  update: { stage: LeadStage; lostReason?: string },
  organizationId?: string
): Promise<Lead | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const touchesContact = update.stage !== "new";
  const row = await queryOne<LeadRow>(
    `update leads set
       stage = $2::lead_stage,
       lost_reason = case when $2::lead_stage = 'lost' then $3 else null end,
       last_contacted_at = case when $4 then now() else last_contacted_at end,
       updated_at = now()
     where id = $1 and organization_id = $5
     returning *`,
    [id, update.stage, update.lostReason ?? null, touchesContact, orgId]
  );
  if (!row) return null;
  const lead = fromLeadRow(row);

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Update lead stage",
    trigger: `Seni moved lead ${id} (${lead.guestName}) to ${update.stage}`,
    decision: update.stage,
    actionTaken:
      update.stage === "lost"
        ? `Marked lost${update.lostReason ? `: ${update.lostReason}` : ""}`
        : update.stage === "booked"
          ? "Marked booked — converted from inquiry to a real reservation"
          : `Stage changed to ${update.stage}`,
    result: update.stage,
  }).catch(() => {});

  return lead;
}

/** Corrects/enriches a lead's own fields — separate from updateLeadStage so
 * editing contact info or notes doesn't read as a stage decision in the AI
 * Activity log. Never touches stage itself. */
export async function updateLeadFields(
  id: string,
  updates: Partial<{
    guestName: string;
    contactEmail: string;
    contactPhone: string;
    source: string;
    desiredArrival: string;
    desiredDeparture: string;
    partySize: number;
    estimatedValueCents: number;
    notes: string;
    nextAction: string;
    nextActionDueAt: string;
  }>,
  organizationId?: string
): Promise<Lead | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const existing = await getLead(id, orgId);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  const row = await queryOne<LeadRow>(
    `update leads set
       guest_name = $2, contact_email = $3, contact_phone = $4, source = $5,
       desired_arrival = $6, desired_departure = $7, party_size = $8,
       estimated_value_cents = $9, notes = $10, next_action = $11, next_action_due_at = $12,
       updated_at = now()
     where id = $1 and organization_id = $13
     returning *`,
    [
      id,
      merged.guestName,
      merged.contactEmail ?? null,
      merged.contactPhone ?? null,
      merged.source,
      merged.desiredArrival ?? null,
      merged.desiredDeparture ?? null,
      merged.partySize ?? null,
      merged.estimatedValueCents ?? null,
      merged.notes ?? null,
      merged.nextAction ?? null,
      merged.nextActionDueAt ?? null,
      orgId,
    ]
  );
  return row ? fromLeadRow(row) : null;
}
