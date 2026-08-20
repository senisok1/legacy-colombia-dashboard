import { query, queryOne } from "./db";

// Deletion (both items and activity-log entries) is restricted to Seni
// specifically, not just any CEO login (2026-08-20, Seni's ask: "only allow
// me, Seni Sok, to delete the activity logs") — there are other CEO/admin
// logins on this org (Ahmed, Geo) who should keep full use of the checklist
// but not the ability to erase history. A plain constant rather than an env
// var or a DB flag: this is a one-person, one-tab policy, not general config.
export const CONSTRUCTION_OWNER_EMAIL = "senisok1@gmail.com";

export function isConstructionOwner(email: string | undefined | null): boolean {
  return (email ?? "").trim().toLowerCase() === CONSTRUCTION_OWNER_EMAIL;
}

// Construction Management tab (2026-08-20, Seni's ask) — an open-items
// checklist scoped to one property group (Legacy Colombia only for now, see
// db/migrations/0042_construction.sql) plus a companion activity log so
// there's always a "who did what" trail. Deliberately simple/English-only:
// unlike Team Activity Log this isn't guest-facing or translated, and the
// people using it (admin/owner + the construction team login) don't need
// the multilingual plumbing the property-management side has.

export type ConstructionItem = {
  id: string;
  title: string;
  notes: string | null;
  /** Free-text grouping, e.g. "Gym" (2026-08-20, Seni's ask). Null = shown
   * under "Uncategorized" client-side. */
  category: string | null;
  completed: boolean;
  completedBy: string | null;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** How many notes are in this item's thread — drives the "Notes (N)"
   * button in ConstructionBoard.tsx without a separate per-item fetch. */
  noteCount: number;
  /** ISO date (YYYY-MM-DD), or null (2026-08-20, Seni's ask: "add estimated
   * date of completion for each open item for the construction team to
   * input"). Editable by anyone with tab access, same as toggling
   * completed — not restricted to Seni. */
  estimatedCompletionDate: string | null;
};

export type ConstructionLogEntry = {
  id: string;
  itemTitle: string;
  action: "created" | "completed" | "reopened" | "deleted" | "noted" | "scheduled";
  /** Extra context for an action that isn't fully self-describing from
   * action+itemTitle alone — currently only "scheduled" uses this (e.g. "Set
   * estimated completion to Aug 25, 2026" or "Cleared estimated completion").
   * Added 2026-08-20 alongside the estimated-completion-date feature. */
  detail: string | null;
  actor: string;
  at: string;
};

/** One entry in an item's notes thread (2026-08-20, Seni's ask: "put in
 * notes on how it was fixed or that it wasn't fixed and what they need to do
 * next"). Append-only — no edit/delete affordance, it's meant as a running
 * progress log rather than a single editable field. */
export type ConstructionItemNote = {
  id: string;
  itemId: string;
  body: string;
  author: string;
  createdAt: string;
};

type ItemRow = {
  id: string;
  title: string;
  notes: string | null;
  category: string | null;
  completed: boolean;
  completed_by_email: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  created_by_email: string;
  created_by_name: string | null;
  created_at: string;
  note_count: string;
  estimated_completion_date: string | null;
};

type NoteRow = {
  id: string;
  item_id: string;
  body: string;
  author_email: string;
  author_name: string | null;
  created_at: string;
};

type LogRow = {
  id: string;
  item_title: string;
  action: string;
  detail: string | null;
  actor_email: string;
  actor_name: string | null;
  at: string;
};

function displayName(email: string, name: string | null): string {
  return name?.trim() || email;
}

function itemFromRow(r: ItemRow): ConstructionItem {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    category: r.category,
    completed: r.completed,
    completedBy: r.completed_by_email ? displayName(r.completed_by_email, r.completed_by_name) : null,
    completedAt: r.completed_at,
    createdBy: displayName(r.created_by_email, r.created_by_name),
    createdAt: r.created_at,
    noteCount: Number(r.note_count) || 0,
    estimatedCompletionDate: r.estimated_completion_date,
  };
}

function logFromRow(r: LogRow): ConstructionLogEntry {
  return {
    id: r.id,
    itemTitle: r.item_title,
    action: r.action as ConstructionLogEntry["action"],
    detail: r.detail,
    actor: displayName(r.actor_email, r.actor_name),
    at: r.at,
  };
}

function noteFromRow(r: NoteRow): ConstructionItemNote {
  return {
    id: r.id,
    itemId: r.item_id,
    body: r.body,
    author: displayName(r.author_email, r.author_name),
    createdAt: r.created_at,
  };
}

/** Open items first (newest first within each group), so the checklist
 * naturally surfaces what's outstanding without a separate filter toggle. */
export async function listConstructionItems(
  organizationId: string,
  propertyGroupId: string
): Promise<ConstructionItem[]> {
  const rows = await query<ItemRow>(
    `select ci.id, ci.title, ci.notes, ci.category, ci.completed, ci.completed_by_email, ci.completed_by_name,
            ci.completed_at, ci.created_by_email, ci.created_by_name, ci.created_at,
            ci.estimated_completion_date::text as estimated_completion_date,
            (select count(*) from construction_item_notes n where n.item_id = ci.id) as note_count
     from construction_items ci
     where ci.organization_id = $1 and ci.property_group_id = $2
     order by ci.completed asc, ci.created_at desc`,
    [organizationId, propertyGroupId]
  );
  return rows.map(itemFromRow);
}

/** One item's notes thread, oldest first (reads top-to-bottom like a
 * conversation). Org+property-group scoped via a join back to
 * construction_items so a construction-team login on one property can't
 * read another's notes via a guessed item id. */
export async function listConstructionItemNotes(
  organizationId: string,
  propertyGroupId: string,
  itemId: string
): Promise<ConstructionItemNote[]> {
  const rows = await query<NoteRow>(
    `select n.id, n.item_id, n.body, n.author_email, n.author_name, n.created_at
     from construction_item_notes n
     join construction_items ci on ci.id = n.item_id
     where n.item_id = $1 and ci.organization_id = $2 and ci.property_group_id = $3
     order by n.created_at asc`,
    [itemId, organizationId, propertyGroupId]
  );
  return rows.map(noteFromRow);
}

/** Appends a note to an item's thread and logs a "noted" activity entry
 * (same denormalized item_title-snapshot pattern as every other action here)
 * so the activity log stays a complete "who did what" trail without anyone
 * having to open each item's notes to notice progress happened. */
export async function addConstructionItemNote(input: {
  organizationId: string;
  propertyGroupId: string;
  itemId: string;
  body: string;
  authorEmail: string;
  authorName: string | null;
}): Promise<ConstructionItemNote | null> {
  const item = await queryOne<{ id: string; title: string }>(
    `select id, title from construction_items where id = $1 and organization_id = $2 and property_group_id = $3`,
    [input.itemId, input.organizationId, input.propertyGroupId]
  );
  if (!item) return null;

  const row = await queryOne<NoteRow>(
    `insert into construction_item_notes
       (organization_id, property_group_id, item_id, body, author_email, author_name)
     values ($1, $2, $3, $4, $5, $6)
     returning id, item_id, body, author_email, author_name, created_at`,
    [input.organizationId, input.propertyGroupId, input.itemId, input.body, input.authorEmail, input.authorName]
  );
  if (!row) throw new Error("Failed to add the note.");

  await logActivity({
    organizationId: input.organizationId,
    propertyGroupId: input.propertyGroupId,
    itemId: item.id,
    itemTitle: item.title,
    action: "noted",
    actorEmail: input.authorEmail,
    actorName: input.authorName,
  });

  return noteFromRow(row);
}

export async function listConstructionActivityLog(
  organizationId: string,
  propertyGroupId: string,
  limit = 200
): Promise<ConstructionLogEntry[]> {
  const rows = await query<LogRow>(
    `select id, item_title, action, detail, actor_email, actor_name, at
     from construction_activity_log
     where organization_id = $1 and property_group_id = $2
     order by at desc
     limit $3`,
    [organizationId, propertyGroupId, limit]
  );
  return rows.map(logFromRow);
}

async function logActivity(input: {
  organizationId: string;
  propertyGroupId: string;
  itemId: string | null;
  itemTitle: string;
  action: ConstructionLogEntry["action"];
  detail?: string | null;
  actorEmail: string;
  actorName: string | null;
}): Promise<void> {
  await query(
    `insert into construction_activity_log
       (organization_id, property_group_id, item_id, item_title, action, detail, actor_email, actor_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.organizationId,
      input.propertyGroupId,
      input.itemId,
      input.itemTitle,
      input.action,
      input.detail ?? null,
      input.actorEmail,
      input.actorName,
    ]
  );
}

export async function createConstructionItem(input: {
  organizationId: string;
  propertyGroupId: string;
  title: string;
  notes: string | null;
  category: string | null;
  authorEmail: string;
  authorName: string | null;
}): Promise<ConstructionItem> {
  const row = await queryOne<ItemRow>(
    `insert into construction_items
       (organization_id, property_group_id, title, notes, category, created_by_email, created_by_name)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, title, notes, category, completed, completed_by_email, completed_by_name, completed_at,
               created_by_email, created_by_name, created_at,
               estimated_completion_date::text as estimated_completion_date,
               '0' as note_count`,
    [
      input.organizationId,
      input.propertyGroupId,
      input.title,
      input.notes,
      input.category,
      input.authorEmail,
      input.authorName,
    ]
  );
  if (!row) throw new Error("Failed to create the item.");
  await logActivity({
    organizationId: input.organizationId,
    propertyGroupId: input.propertyGroupId,
    itemId: row.id,
    itemTitle: row.title,
    action: "created",
    actorEmail: input.authorEmail,
    actorName: input.authorName,
  });
  return itemFromRow(row);
}

/** Toggles an item's completed state. Org+property-group scoped so a
 * construction-team login on one property can't touch another's items via a
 * guessed id. Returns null if no matching row. */
export async function setConstructionItemCompleted(input: {
  organizationId: string;
  propertyGroupId: string;
  id: string;
  completed: boolean;
  actorEmail: string;
  actorName: string | null;
}): Promise<ConstructionItem | null> {
  const row = await queryOne<ItemRow>(
    `update construction_items ci
       set completed = $4,
           completed_by_email = case when $4 then $5 else null end,
           completed_by_name = case when $4 then $6 else null end,
           completed_at = case when $4 then now() else null end
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id, title, notes, category, completed, completed_by_email, completed_by_name, completed_at,
               created_by_email, created_by_name, created_at,
               estimated_completion_date::text as estimated_completion_date,
               (select count(*) from construction_item_notes n where n.item_id = ci.id) as note_count`,
    [input.id, input.organizationId, input.propertyGroupId, input.completed, input.actorEmail, input.actorName]
  );
  if (!row) return null;
  await logActivity({
    organizationId: input.organizationId,
    propertyGroupId: input.propertyGroupId,
    itemId: row.id,
    itemTitle: row.title,
    action: input.completed ? "completed" : "reopened",
    actorEmail: input.actorEmail,
    actorName: input.actorName,
  });
  return itemFromRow(row);
}

/** "2026-08-25" -> "Aug 25, 2026". Formats explicitly in UTC — the value is
 * a pure calendar date with no time component, and letting toLocaleDateString
 * fall back to the machine's local timezone can silently shift a date like
 * "2026-08-25" back a day in negative-UTC-offset zones. */
function formatEstimatedDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Sets or clears an item's estimated completion date (2026-08-20, Seni's
 * ask: "add estimated date of completion for each open item for the
 * construction team to input... add that to the activity log so we can see
 * if they modified this date"). Open to anyone with tab access (CEO or the
 * CONSTRUCTION login) — enforced by the caller, see api/construction/
 * route.ts's canAccessConstruction, same gate as toggling completed. */
export async function setConstructionItemEstimatedCompletion(input: {
  organizationId: string;
  propertyGroupId: string;
  id: string;
  estimatedCompletionDate: string | null;
  actorEmail: string;
  actorName: string | null;
}): Promise<ConstructionItem | null> {
  const row = await queryOne<ItemRow>(
    `update construction_items ci
       set estimated_completion_date = $4
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id, title, notes, category, completed, completed_by_email, completed_by_name, completed_at,
               created_by_email, created_by_name, created_at,
               estimated_completion_date::text as estimated_completion_date,
               (select count(*) from construction_item_notes n where n.item_id = ci.id) as note_count`,
    [input.id, input.organizationId, input.propertyGroupId, input.estimatedCompletionDate]
  );
  if (!row) return null;
  await logActivity({
    organizationId: input.organizationId,
    propertyGroupId: input.propertyGroupId,
    itemId: row.id,
    itemTitle: row.title,
    action: "scheduled",
    detail: input.estimatedCompletionDate
      ? `Set estimated completion to ${formatEstimatedDate(input.estimatedCompletionDate)}`
      : "Cleared estimated completion date",
    actorEmail: input.actorEmail,
    actorName: input.actorName,
  });
  return itemFromRow(row);
}

/** Admin/owner only (enforced by the caller — see api/construction/route.ts).
 * Logs the deletion with a title snapshot before removing the row. */
export async function deleteConstructionItem(input: {
  organizationId: string;
  propertyGroupId: string;
  id: string;
  actorEmail: string;
  actorName: string | null;
}): Promise<boolean> {
  const row = await queryOne<{ id: string; title: string }>(
    `delete from construction_items
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id, title`,
    [input.id, input.organizationId, input.propertyGroupId]
  );
  if (!row) return false;
  await logActivity({
    organizationId: input.organizationId,
    propertyGroupId: input.propertyGroupId,
    itemId: null,
    itemTitle: row.title,
    action: "deleted",
    actorEmail: input.actorEmail,
    actorName: input.actorName,
  });
  return true;
}

/** Deletes a single activity log entry outright — no replacement record,
 * unlike deleteConstructionItem (which logs its own deletion). Restricted
 * to Seni specifically, not just any CEO login (2026-08-20, Seni's ask) —
 * enforced by the caller, see api/construction/log/route.ts. */
export async function deleteConstructionActivityLogEntry(
  organizationId: string,
  propertyGroupId: string,
  id: string
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `delete from construction_activity_log
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id`,
    [id, organizationId, propertyGroupId]
  );
  return Boolean(row);
}
