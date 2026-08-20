import { query, queryOne, withClient } from "./db";

// Construction Budget (2026-08-20, Seni's ask) — the imported spreadsheet's
// line items, grouped by chapter/category, with an editable Actual (USD)
// column for tracking real spend against the original budget over time. See
// db/migrations/0044_construction_budget.sql for the schema rationale.

export type ConstructionBudgetItem = {
  id: string;
  code: string | null;
  category: string;
  categoryOriginal: string | null;
  description: string;
  descriptionOriginal: string | null;
  unit: string | null;
  quantity: number | null;
  unitPriceCop: number | null;
  totalCop: number | null;
  budgetedUsd: number | null;
  actualUsd: number | null;
  notes: string | null;
  sortOrder: number;
  updatedAt: string;
  updatedBy: string | null;
};

type Row = {
  id: string;
  code: string | null;
  category: string;
  category_original: string | null;
  description: string;
  description_original: string | null;
  unit: string | null;
  quantity: string | null;
  unit_price_cop: string | null;
  total_cop: string | null;
  budgeted_usd: string | null;
  actual_usd: string | null;
  notes: string | null;
  sort_order: number;
  updated_at: string;
  updated_by_email: string | null;
  updated_by_name: string | null;
};

const COLUMNS =
  "id, code, category, category_original, description, description_original, unit, quantity, " +
  "unit_price_cop, total_cop, budgeted_usd, actual_usd, notes, sort_order, updated_at, " +
  "updated_by_email, updated_by_name";

// node-postgres returns numeric columns as strings (to avoid float
// precision surprises on large money values) — parse to number here so
// every caller/consumer works with plain numbers, same convention as the
// rest of this app's money handling.
function num(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fromRow(r: Row): ConstructionBudgetItem {
  return {
    id: r.id,
    code: r.code,
    category: r.category,
    categoryOriginal: r.category_original,
    description: r.description,
    descriptionOriginal: r.description_original,
    unit: r.unit,
    quantity: num(r.quantity),
    unitPriceCop: num(r.unit_price_cop),
    totalCop: num(r.total_cop),
    budgetedUsd: num(r.budgeted_usd),
    actualUsd: num(r.actual_usd),
    notes: r.notes,
    sortOrder: r.sort_order,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by_name?.trim() || r.updated_by_email,
  };
}

// Activity log (2026-08-20, Seni's ask: "add an activity log button here
// too... so that we can monitor who entered what on this screen"). Mirrors
// construction_activity_log's role in lib/construction.ts, but its own
// table (construction_budget_activity_log) since budget rows live in a
// separate table with a separate lifecycle (import/replace, not create/
// complete). Collapsed-by-default in the UI, same pattern as the other two
// activity logs in this app.
export type ConstructionBudgetLogEntry = {
  id: string;
  itemDescription: string | null;
  action: "imported" | "updated" | "deleted";
  detail: string | null;
  actor: string;
  at: string;
};

type LogRow = {
  id: string;
  item_description: string | null;
  action: string;
  detail: string | null;
  actor_email: string;
  actor_name: string | null;
  at: string;
};

function logFromRow(r: LogRow): ConstructionBudgetLogEntry {
  return {
    id: r.id,
    itemDescription: r.item_description,
    action: r.action as ConstructionBudgetLogEntry["action"],
    detail: r.detail,
    actor: r.actor_name?.trim() || r.actor_email,
    at: r.at,
  };
}

export async function listConstructionBudgetActivityLog(
  organizationId: string,
  propertyGroupId: string,
  limit = 200
): Promise<ConstructionBudgetLogEntry[]> {
  const rows = await query<LogRow>(
    `select id, item_description, action, detail, actor_email, actor_name, at
     from construction_budget_activity_log
     where organization_id = $1 and property_group_id = $2
     order by at desc
     limit $3`,
    [organizationId, propertyGroupId, limit]
  );
  return rows.map(logFromRow);
}

/** Deletes a single activity-log entry outright. Restricted to Seni
 * specifically — enforced by the caller, see
 * api/construction-budget/log/route.ts (same policy as the Construction
 * Management checklist's log, and as import/delete on this budget itself). */
export async function deleteConstructionBudgetActivityLogEntry(
  organizationId: string,
  propertyGroupId: string,
  id: string
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `delete from construction_budget_activity_log
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id`,
    [id, organizationId, propertyGroupId]
  );
  return Boolean(row);
}

export async function listConstructionBudgetItems(
  organizationId: string,
  propertyGroupId: string
): Promise<ConstructionBudgetItem[]> {
  const rows = await query<Row>(
    `select ${COLUMNS} from construction_budget_items
     where organization_id = $1 and property_group_id = $2
     order by sort_order asc`,
    [organizationId, propertyGroupId]
  );
  return rows.map(fromRow);
}

export type ImportRow = {
  code: string | null;
  category: string;
  categoryOriginal: string | null;
  description: string;
  descriptionOriginal: string | null;
  unit: string | null;
  quantity: number | null;
  unitPriceCop: number | null;
  totalCop: number | null;
  budgetedUsd: number | null;
};

/** Replaces the ENTIRE budget for one org+property group with a freshly
 * pasted/imported set of rows — a re-import (revised budget version)
 * intentionally wipes what was there before rather than trying to diff/
 * merge against a source that has no stable row id of its own. Runs in a
 * single transaction so a failure never leaves the budget half-deleted. */
export async function replaceConstructionBudgetItems(
  organizationId: string,
  propertyGroupId: string,
  items: ImportRow[],
  actorEmail: string,
  actorName: string | null
): Promise<number> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        "delete from construction_budget_items where organization_id = $1 and property_group_id = $2",
        [organizationId, propertyGroupId]
      );
      let i = 0;
      for (const item of items) {
        i += 1;
        await client.query(
          `insert into construction_budget_items
             (organization_id, property_group_id, code, category, category_original, description,
              description_original, unit, quantity, unit_price_cop, total_cop, budgeted_usd, sort_order)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            organizationId,
            propertyGroupId,
            item.code,
            item.category,
            item.categoryOriginal,
            item.description,
            item.descriptionOriginal,
            item.unit,
            item.quantity,
            item.unitPriceCop,
            item.totalCop,
            item.budgetedUsd,
            i,
          ]
        );
      }
      // Logged inside the same transaction — an import that fails partway
      // rolls back the log entry too, so the log never claims an import
      // happened when it didn't.
      await client.query(
        `insert into construction_budget_activity_log
           (organization_id, property_group_id, item_id, item_description, action, detail, actor_email, actor_name)
         values ($1, $2, null, null, 'imported', $3, $4, $5)`,
        [organizationId, propertyGroupId, `${items.length} line item(s)`, actorEmail, actorName]
      );
      await client.query("commit");
      return items.length;
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  });
}

/** Updates the editable fields on one line item — actual spend and notes.
 * Everything else (code/category/description/budgeted figures) only ever
 * changes via a full re-import, since it's sourced from the spreadsheet. */
export async function updateConstructionBudgetItem(input: {
  organizationId: string;
  propertyGroupId: string;
  id: string;
  actualUsd?: number | null;
  notes?: string | null;
  actorEmail: string;
  actorName: string | null;
}): Promise<ConstructionBudgetItem | null> {
  const sets: string[] = ["updated_at = now()", "updated_by_email = $4", "updated_by_name = $5"];
  const values: unknown[] = [input.id, input.organizationId, input.propertyGroupId, input.actorEmail, input.actorName];
  if (input.actualUsd !== undefined) {
    values.push(input.actualUsd);
    sets.push(`actual_usd = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }
  const row = await queryOne<Row>(
    `update construction_budget_items set ${sets.join(", ")}
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning ${COLUMNS}`,
    values
  );
  if (!row) return null;

  // Human-readable summary of what changed — the log line itself stays
  // short; the full note text is already visible on the row.
  const parts: string[] = [];
  if (input.actualUsd !== undefined) {
    parts.push(input.actualUsd === null ? "Actual cleared" : `Actual set to $${Math.round(input.actualUsd).toLocaleString("en-US")}`);
  }
  if (input.notes !== undefined) parts.push("Notes updated");
  if (parts.length > 0) {
    await query(
      `insert into construction_budget_activity_log
         (organization_id, property_group_id, item_id, item_description, action, detail, actor_email, actor_name)
       values ($1, $2, $3, $4, 'updated', $5, $6, $7)`,
      [input.organizationId, input.propertyGroupId, row.id, row.description, parts.join("; "), input.actorEmail, input.actorName]
    );
  }
  return fromRow(row);
}

export async function deleteConstructionBudgetItem(input: {
  organizationId: string;
  propertyGroupId: string;
  id: string;
  actorEmail: string;
  actorName: string | null;
}): Promise<boolean> {
  const row = await queryOne<{ id: string; description: string }>(
    `delete from construction_budget_items
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id, description`,
    [input.id, input.organizationId, input.propertyGroupId]
  );
  if (!row) return false;
  await query(
    `insert into construction_budget_activity_log
       (organization_id, property_group_id, item_id, item_description, action, actor_email, actor_name)
     values ($1, $2, null, $3, 'deleted', $4, $5)`,
    [input.organizationId, input.propertyGroupId, row.description, input.actorEmail, input.actorName]
  );
  return true;
}
