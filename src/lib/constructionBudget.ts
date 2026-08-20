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
  items: ImportRow[]
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
  return row ? fromRow(row) : null;
}

export async function deleteConstructionBudgetItem(
  organizationId: string,
  propertyGroupId: string,
  id: string
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `delete from construction_budget_items
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id`,
    [id, organizationId, propertyGroupId]
  );
  return Boolean(row);
}
