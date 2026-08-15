import { query, queryOne } from "./db";
import type { CrmGuestRecord, MessageLogEntry, MessageTemplate } from "./types";
import { getDefaultOrganizationId } from "./organizations";

// Everything the OwnerRez API doesn't store for us (guest notes/tags, message
// templates, a log of messages sent) lives in Postgres — see
// docs/architecture/PHASE1_CRM_FOUNDATION.md and db/migrations/0001_init.sql.
// This used to be flat JSON files under /data, which didn't reliably persist
// on Vercel's read-only serverless filesystem; moved to the CRM foundation
// database as part of Phase 1.
//
// All functions here are async now (they weren't before) — every call site
// was updated to await them as part of this migration.

// ---------- Guest CRM notes/tags ----------

type GuestNoteRow = {
  guest_id: number;
  notes: string;
  tags: string[];
  updated_at: Date;
};

function fromGuestNoteRow(row: GuestNoteRow): CrmGuestRecord {
  return {
    guestId: row.guest_id,
    notes: row.notes,
    tags: row.tags,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getCrmRecord(
  guestId: number,
  organizationId?: string
): Promise<CrmGuestRecord | undefined> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<GuestNoteRow>(
    "select * from guest_notes where organization_id = $1 and guest_id = $2",
    [orgId, guestId]
  );
  return row ? fromGuestNoteRow(row) : undefined;
}

/** Batch lookup — fetches every requested guest's notes/tags in a single
 * round trip instead of one query per guest. Use this (not a loop of
 * getCrmRecord) anywhere you're building a list of many guests at once; see
 * lib/guests.ts's buildGuestsWithStats, and the redisMGet lesson documented
 * there in translate.ts for why a per-item await loop is the classic hidden
 * slowness in this app. */
export async function getCrmRecordsByGuestIds(
  guestIds: number[],
  organizationId?: string
): Promise<Map<number, CrmGuestRecord>> {
  const map = new Map<number, CrmGuestRecord>();
  if (guestIds.length === 0) return map;
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<GuestNoteRow>(
    "select * from guest_notes where organization_id = $1 and guest_id = any($2)",
    [orgId, guestIds]
  );
  for (const row of rows) map.set(row.guest_id, fromGuestNoteRow(row));
  return map;
}

export async function upsertCrmRecord(
  guestId: number,
  updates: { notes?: string; tags?: string[] },
  organizationId?: string
): Promise<CrmGuestRecord> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const existing = await getCrmRecord(guestId, orgId);
  const notes = updates.notes ?? existing?.notes ?? "";
  const tags = updates.tags ?? existing?.tags ?? [];
  // ON CONFLICT target must match migration 0015's composite unique index
  // guest_notes_org_guest_idx(organization_id, guest_id) — the old
  // single-column guest_notes_guest_id_key constraint this used to target
  // was dropped there (two tenants' OwnerRez accounts can reuse the same
  // numeric guest id), so "on conflict (guest_id)" alone would now error
  // with "no unique or exclusion constraint matching the ON CONFLICT
  // specification" instead of upserting.
  const row = await queryOne<GuestNoteRow>(
    `insert into guest_notes (organization_id, guest_id, notes, tags)
     values ($1, $2, $3, $4)
     on conflict (organization_id, guest_id) do update set notes = excluded.notes, tags = excluded.tags, updated_at = now()
     returning *`,
    [orgId, guestId, notes, tags]
  );
  if (!row) throw new Error("Failed to save guest CRM record.");
  return fromGuestNoteRow(row);
}

// ---------- Message templates ----------

type TemplateRow = {
  id: string;
  name: string;
  trigger: MessageTemplate["trigger"];
  days_offset: number;
  subject: string;
  body_en: string;
  body_es: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function fromTemplateRow(row: TemplateRow): MessageTemplate {
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger,
    daysOffset: row.days_offset,
    subject: row.subject,
    bodyEn: row.body_en,
    bodyEs: row.body_es,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function defaultTemplates(): Omit<MessageTemplate, "id" | "createdAt" | "updatedAt">[] {
  return [
    {
      name: "Pre-arrival info",
      trigger: "pre_arrival",
      daysOffset: -3,
      subject: "Your upcoming stay at Legacy Colombia",
      bodyEn:
        "Hi {{guest_first_name}},\n\nWe're looking forward to hosting you at Legacy Colombia starting {{arrival_date}}. Here's everything you need for check-in: [directions/access code]. Let us know if you have any questions before you arrive!\n\n— The Legacy Colombia team",
      bodyEs:
        "Hola {{guest_first_name}},\n\nEstamos felices de recibirte en Legacy Colombia a partir del {{arrival_date}}. Aquí tienes todo lo necesario para el check-in: [indicaciones/código de acceso]. Avísanos si tienes alguna pregunta antes de tu llegada.\n\n— El equipo de Legacy Colombia",
      active: true,
    },
    {
      name: "Check-in day welcome",
      trigger: "check_in",
      daysOffset: 0,
      subject: "Welcome! Settling in okay?",
      bodyEn:
        "Hi {{guest_first_name}}, welcome to Legacy Colombia! We hope check-in went smoothly. Reach out any time if you need anything during your stay.",
      bodyEs:
        "Hola {{guest_first_name}}, ¡bienvenido/a a Legacy Colombia! Esperamos que el check-in haya sido sencillo. Escríbenos en cualquier momento si necesitas algo durante tu estadía.",
      active: true,
    },
    {
      name: "Post-stay review request",
      trigger: "post_stay_review",
      daysOffset: 1,
      subject: "Thanks for staying with us!",
      bodyEn:
        "Hi {{guest_first_name}}, thank you for staying at Legacy Colombia! If you have a moment, a review would mean a lot to us. We hope to host you again soon.",
      bodyEs:
        "Hola {{guest_first_name}}, ¡gracias por hospedarte en Legacy Colombia! Si tienes un momento, nos encantaría que dejaras una reseña. Esperamos recibirte de nuevo pronto.",
      active: true,
    },
  ];
}

export async function listTemplates(organizationId?: string): Promise<MessageTemplate[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<TemplateRow>(
    "select * from message_templates where organization_id = $1 order by created_at asc",
    [orgId]
  );
  if (rows.length > 0) return rows.map(fromTemplateRow);

  // First run — seed the three starter templates.
  const seeded: MessageTemplate[] = [];
  for (const t of defaultTemplates()) {
    const row = await queryOne<TemplateRow>(
      `insert into message_templates (organization_id, name, trigger, days_offset, subject, body_en, body_es, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [orgId, t.name, t.trigger, t.daysOffset, t.subject, t.bodyEn, t.bodyEs, t.active]
    );
    if (row) seeded.push(fromTemplateRow(row));
  }
  return seeded;
}

export async function saveTemplate(template: MessageTemplate, organizationId?: string): Promise<MessageTemplate> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  // template.id is a globally-unique uuid, so "on conflict (id)" is still
  // valid post-migration (unlike guest_notes/guest_id above, id's own
  // uniqueness was never widened to be per-org).
  const row = await queryOne<TemplateRow>(
    `insert into message_templates (id, organization_id, name, trigger, days_offset, subject, body_en, body_es, active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set
       name = excluded.name, trigger = excluded.trigger, days_offset = excluded.days_offset,
       subject = excluded.subject, body_en = excluded.body_en, body_es = excluded.body_es,
       active = excluded.active, updated_at = now()
     returning *`,
    [
      template.id,
      orgId,
      template.name,
      template.trigger,
      template.daysOffset,
      template.subject,
      template.bodyEn,
      template.bodyEs,
      template.active,
    ]
  );
  if (!row) throw new Error("Failed to save message template.");
  return fromTemplateRow(row);
}

export async function deleteTemplate(id: string, organizationId?: string): Promise<void> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await query("delete from message_templates where id = $1 and organization_id = $2", [id, orgId]);
}

// ---------- Message log ----------

type MessageLogRow = {
  id: string;
  booking_id: number;
  guest_id: number | null;
  guest_name: string | null;
  template_id: string | null;
  template_name: string | null;
  language: MessageLogEntry["language"];
  subject: string;
  body: string;
  status: MessageLogEntry["status"];
  created_at: Date;
};

function fromMessageLogRow(row: MessageLogRow): MessageLogEntry {
  return {
    id: row.id,
    bookingId: row.booking_id,
    guestId: row.guest_id,
    guestName: row.guest_name ?? undefined,
    templateId: row.template_id ?? undefined,
    templateName: row.template_name ?? undefined,
    language: row.language,
    subject: row.subject,
    body: row.body,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listMessages(organizationId?: string): Promise<MessageLogEntry[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<MessageLogRow>(
    "select * from message_log where organization_id = $1 order by created_at desc",
    [orgId]
  );
  return rows.map(fromMessageLogRow);
}

export async function appendMessage(
  entry: Omit<MessageLogEntry, "id" | "createdAt">,
  organizationId?: string
): Promise<MessageLogEntry> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<MessageLogRow>(
    `insert into message_log (organization_id, booking_id, guest_id, guest_name, template_id, template_name, language, subject, body, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      orgId,
      entry.bookingId,
      entry.guestId,
      entry.guestName ?? null,
      entry.templateId ?? null,
      entry.templateName ?? null,
      entry.language,
      entry.subject,
      entry.body,
      entry.status,
    ]
  );
  if (!row) throw new Error("Failed to log message.");
  return fromMessageLogRow(row);
}
