import { query, queryOne } from "./db";

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
  completed: boolean;
  completedBy: string | null;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
};

export type ConstructionLogEntry = {
  id: string;
  itemTitle: string;
  action: "created" | "completed" | "reopened" | "deleted";
  actor: string;
  at: string;
};

type ItemRow = {
  id: string;
  title: string;
  notes: string | null;
  completed: boolean;
  completed_by_email: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  created_by_email: string;
  created_by_name: string | null;
  created_at: string;
};

type LogRow = {
  id: string;
  item_title: string;
  action: string;
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
    completed: r.completed,
    completedBy: r.completed_by_email ? displayName(r.completed_by_email, r.completed_by_name) : null,
    completedAt: r.completed_at,
    createdBy: displayName(r.created_by_email, r.created_by_name),
    createdAt: r.created_at,
  };
}

function logFromRow(r: LogRow): ConstructionLogEntry {
  return {
    id: r.id,
    itemTitle: r.item_title,
    action: r.action as ConstructionLogEntry["action"],
    actor: displayName(r.actor_email, r.actor_name),
    at: r.at,
  };
}

/** Open items first (newest first within each group), so the checklist
 * naturally surfaces what's outstanding without a separate filter toggle. */
export async function listConstructionItems(
  organizationId: string,
  propertyGroupId: string
): Promise<ConstructionItem[]> {
  const rows = await query<ItemRow>(
    `select id, title, notes, completed, completed_by_email, completed_by_name, completed_at,
            created_by_email, created_by_name, created_at
     from construction_items
     where organization_id = $1 and property_group_id = $2
     order by completed asc, created_at desc`,
    [organizationId, propertyGroupId]
  );
  return rows.map(itemFromRow);
}

export async function listConstructionActivityLog(
  organizationId: string,
  propertyGroupId: string,
  limit = 200
): Promise<ConstructionLogEntry[]> {
  const rows = await query<LogRow>(
    `select id, item_title, action, actor_email, actor_name, at
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
  actorEmail: string;
  actorName: string | null;
}): Promise<void> {
  await query(
    `insert into construction_activity_log
       (organization_id, property_group_id, item_id, item_title, action, actor_email, actor_name)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.organizationId,
      input.propertyGroupId,
      input.itemId,
      input.itemTitle,
      input.action,
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
  authorEmail: string;
  authorName: string | null;
}): Promise<ConstructionItem> {
  const row = await queryOne<ItemRow>(
    `insert into construction_items
       (organization_id, property_group_id, title, notes, created_by_email, created_by_name)
     values ($1, $2, $3, $4, $5, $6)
     returning id, title, notes, completed, completed_by_email, completed_by_name, completed_at,
               created_by_email, created_by_name, created_at`,
    [input.organizationId, input.propertyGroupId, input.title, input.notes, input.authorEmail, input.authorName]
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
    `update construction_items
       set completed = $4,
           completed_by_email = case when $4 then $5 else null end,
           completed_by_name = case when $4 then $6 else null end,
           completed_at = case when $4 then now() else null end
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id, title, notes, completed, completed_by_email, completed_by_name, completed_at,
               created_by_email, created_by_name, created_at`,
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
