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
  /** How many notes are in this item's thread — drives the "Notes (N)"
   * button in ConstructionBudgetBoard.tsx without a separate per-item fetch
   * (2026-08-20, Seni's ask: "add a notes button for each item in the
   * budget for any user to add notes"). Same pattern as
   * ConstructionItem.noteCount in lib/construction.ts. */
  noteCount: number;
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
  note_count: string;
};

const COLUMNS =
  "cbi.id, cbi.code, cbi.category, cbi.category_original, cbi.description, cbi.description_original, cbi.unit, " +
  "cbi.quantity, cbi.unit_price_cop, cbi.total_cop, cbi.budgeted_usd, cbi.actual_usd, cbi.notes, cbi.sort_order, " +
  "cbi.updated_at, cbi.updated_by_email, cbi.updated_by_name, " +
  "(select count(*) from construction_budget_item_notes n where n.item_id = cbi.id) as note_count";

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
    noteCount: Number(r.note_count) || 0,
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
  action: "imported" | "updated" | "deleted" | "noted" | "deposited";
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
    `select ${COLUMNS} from construction_budget_items cbi
     where cbi.organization_id = $1 and cbi.property_group_id = $2
     order by cbi.sort_order asc`,
    [organizationId, propertyGroupId]
  );
  return rows.map(fromRow);
}

/** One budget line item's notes thread, oldest first — same append-only,
 * org+property-group-scoped pattern as listConstructionItemNotes in
 * lib/construction.ts (2026-08-20, Seni's ask: "add a notes button for each
 * item in the budget for any user to add notes"). */
export type ConstructionBudgetItemNote = {
  id: string;
  itemId: string;
  body: string;
  author: string;
  createdAt: string;
};

type NoteRow = {
  id: string;
  item_id: string;
  body: string;
  author_email: string;
  author_name: string | null;
  created_at: string;
};

function noteFromRow(r: NoteRow): ConstructionBudgetItemNote {
  return {
    id: r.id,
    itemId: r.item_id,
    body: r.body,
    author: r.author_name?.trim() || r.author_email,
    createdAt: r.created_at,
  };
}

export async function listConstructionBudgetItemNotes(
  organizationId: string,
  propertyGroupId: string,
  itemId: string
): Promise<ConstructionBudgetItemNote[]> {
  const rows = await query<NoteRow>(
    `select n.id, n.item_id, n.body, n.author_email, n.author_name, n.created_at
     from construction_budget_item_notes n
     join construction_budget_items cbi on cbi.id = n.item_id
     where n.item_id = $1 and cbi.organization_id = $2 and cbi.property_group_id = $3
     order by n.created_at asc`,
    [itemId, organizationId, propertyGroupId]
  );
  return rows.map(noteFromRow);
}

/** Appends a note to a budget line item's thread and logs a "noted" activity
 * entry, same pattern as addConstructionItemNote in lib/construction.ts.
 * Open to any viewer of this tab (CEO or CONSTRUCTION) — enforced by the
 * caller, see api/construction-budget/notes/route.ts. */
export async function addConstructionBudgetItemNote(input: {
  organizationId: string;
  propertyGroupId: string;
  itemId: string;
  body: string;
  authorEmail: string;
  authorName: string | null;
}): Promise<ConstructionBudgetItemNote | null> {
  const item = await queryOne<{ id: string; description: string }>(
    `select id, description from construction_budget_items
     where id = $1 and organization_id = $2 and property_group_id = $3`,
    [input.itemId, input.organizationId, input.propertyGroupId]
  );
  if (!item) return null;

  const row = await queryOne<NoteRow>(
    `insert into construction_budget_item_notes
       (organization_id, property_group_id, item_id, body, author_email, author_name)
     values ($1, $2, $3, $4, $5, $6)
     returning id, item_id, body, author_email, author_name, created_at`,
    [input.organizationId, input.propertyGroupId, input.itemId, input.body, input.authorEmail, input.authorName]
  );
  if (!row) throw new Error("Failed to add the note.");

  await query(
    `insert into construction_budget_activity_log
       (organization_id, property_group_id, item_id, item_description, action, detail, actor_email, actor_name)
     values ($1, $2, $3, $4, 'noted', null, $5, $6)`,
    [input.organizationId, input.propertyGroupId, item.id, item.description, input.authorEmail, input.authorName]
  );

  return noteFromRow(row);
}

// Editable COP -> USD exchange rate (2026-08-20, Seni's ask: "this is
// currently at a 3700 COP to USD exchange rate. add a box somewhere where I
// can modify that rate which will then modify the USD budget"). The source
// spreadsheet baked in a fixed historical rate when it computed each row's
// Budgeted (USD) — this makes that number live instead: applyFxRate()
// recomputes budgetedUsd = totalCop / rate for every row that has a
// totalCop, falling back to the originally-imported figure only when a row
// has no totalCop to recompute from. See db/migrations/0047.
export const DEFAULT_FX_RATE_COP_PER_USD = 3700;

export async function getConstructionBudgetFxRate(organizationId: string, propertyGroupId: string): Promise<number> {
  const row = await queryOne<{ fx_rate_cop_per_usd: string }>(
    `select fx_rate_cop_per_usd from construction_budget_settings
     where organization_id = $1 and property_group_id = $2`,
    [organizationId, propertyGroupId]
  );
  const rate = row ? Number(row.fx_rate_cop_per_usd) : DEFAULT_FX_RATE_COP_PER_USD;
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_FX_RATE_COP_PER_USD;
}

/** Seni-only (enforced by the caller — see api/construction-budget/fx-rate/
 * route.ts) — the rate materially changes every Budgeted (USD) figure on the
 * tab, same "changing the budget" policy as import/delete. */
export async function setConstructionBudgetFxRate(input: {
  organizationId: string;
  propertyGroupId: string;
  rate: number;
  actorEmail: string;
  actorName: string | null;
}): Promise<number> {
  await query(
    `insert into construction_budget_settings
       (organization_id, property_group_id, fx_rate_cop_per_usd, updated_at, updated_by_email, updated_by_name)
     values ($1, $2, $3, now(), $4, $5)
     on conflict (organization_id, property_group_id)
     do update set fx_rate_cop_per_usd = excluded.fx_rate_cop_per_usd, updated_at = now(),
                    updated_by_email = excluded.updated_by_email, updated_by_name = excluded.updated_by_name`,
    [input.organizationId, input.propertyGroupId, input.rate, input.actorEmail, input.actorName]
  );
  await query(
    `insert into construction_budget_activity_log
       (organization_id, property_group_id, item_id, item_description, action, detail, actor_email, actor_name)
     values ($1, $2, null, null, 'updated', $3, $4, $5)`,
    [
      input.organizationId,
      input.propertyGroupId,
      `FX rate set to ${input.rate.toLocaleString("en-US")} COP/USD`,
      input.actorEmail,
      input.actorName,
    ]
  );
  return input.rate;
}

/** Recomputes Budgeted (USD) from each row's total_cop at the given rate —
 * pure function, no DB access, so the same logic can be reused wherever
 * items are read (list, single-row fetches) without duplicating it. */
export function applyFxRate(items: ConstructionBudgetItem[], rateCopPerUsd: number): ConstructionBudgetItem[] {
  if (!Number.isFinite(rateCopPerUsd) || rateCopPerUsd <= 0) return items;
  return items.map((item) => (item.totalCop !== null ? { ...item, budgetedUsd: item.totalCop / rateCopPerUsd } : item));
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
    `update construction_budget_items cbi set ${sets.join(", ")}
     where cbi.id = $1 and cbi.organization_id = $2 and cbi.property_group_id = $3
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

// Construction Funds — a deposits ledger separate from
// construction_budget_items (2026-08-20, Seni's ask: "a 'remaining balance'
// box that shows construction funds I've deposited but haven't been used
// yet... a column that shows where the balance is spent so that funds that
// I deposit are always accounted for"). Deposits live in their own table so
// a budget re-import (which wipes and recreates construction_budget_items,
// see replaceConstructionBudgetItems above) never touches them — Seni's
// framing ("these items will always have to be added after an import by the
// CRM") confirmed deposits are managed entirely in the CRM, not sourced from
// the spreadsheet. "Spent" is computed live from actual_usd, which is
// already the existing per-line "real spend" field on this tab.
export type ConstructionFundsDeposit = {
  id: string;
  amountUsd: number;
  note: string | null;
  depositedAt: string;
  createdAt: string;
  createdBy: string;
};

type DepositRow = {
  id: string;
  amount_usd: string;
  note: string | null;
  deposited_at: string;
  created_at: string;
  created_by_email: string;
  created_by_name: string | null;
};

function depositFromRow(r: DepositRow): ConstructionFundsDeposit {
  return {
    id: r.id,
    amountUsd: Number(r.amount_usd),
    note: r.note,
    depositedAt: r.deposited_at,
    createdAt: r.created_at,
    createdBy: r.created_by_name?.trim() || r.created_by_email,
  };
}

export async function listConstructionFundsDeposits(
  organizationId: string,
  propertyGroupId: string
): Promise<ConstructionFundsDeposit[]> {
  const rows = await query<DepositRow>(
    `select id, amount_usd, note, deposited_at, created_at, created_by_email, created_by_name
     from construction_funds_deposits
     where organization_id = $1 and property_group_id = $2
     order by deposited_at desc, created_at desc`,
    [organizationId, propertyGroupId]
  );
  return rows.map(depositFromRow);
}

/** Seni-only (enforced by the caller, see api/construction-budget/funds/
 * route.ts) — logging a deposit is a real money event, same trust tier as
 * import/delete/FX rate on this tab. */
export async function addConstructionFundsDeposit(input: {
  organizationId: string;
  propertyGroupId: string;
  amountUsd: number;
  note: string | null;
  depositedAt: string | null;
  actorEmail: string;
  actorName: string | null;
}): Promise<ConstructionFundsDeposit> {
  const row = await queryOne<DepositRow>(
    `insert into construction_funds_deposits
       (organization_id, property_group_id, amount_usd, note, deposited_at, created_by_email, created_by_name)
     values ($1, $2, $3, $4, coalesce($5::date, current_date), $6, $7)
     returning id, amount_usd, note, deposited_at, created_at, created_by_email, created_by_name`,
    [input.organizationId, input.propertyGroupId, input.amountUsd, input.note, input.depositedAt, input.actorEmail, input.actorName]
  );
  if (!row) throw new Error("Failed to record the deposit.");

  await query(
    `insert into construction_budget_activity_log
       (organization_id, property_group_id, item_id, item_description, action, detail, actor_email, actor_name)
     values ($1, $2, null, null, 'deposited', $3, $4, $5)`,
    [
      input.organizationId,
      input.propertyGroupId,
      `$${Math.round(input.amountUsd).toLocaleString("en-US")} deposited${input.note ? ` — ${input.note}` : ""}`,
      input.actorEmail,
      input.actorName,
    ]
  );

  return depositFromRow(row);
}

/** Seni-only, same policy as addConstructionFundsDeposit. */
export async function deleteConstructionFundsDeposit(input: {
  organizationId: string;
  propertyGroupId: string;
  id: string;
  actorEmail: string;
  actorName: string | null;
}): Promise<boolean> {
  const row = await queryOne<{ id: string; amount_usd: string }>(
    `delete from construction_funds_deposits
     where id = $1 and organization_id = $2 and property_group_id = $3
     returning id, amount_usd`,
    [input.id, input.organizationId, input.propertyGroupId]
  );
  if (!row) return false;

  await query(
    `insert into construction_budget_activity_log
       (organization_id, property_group_id, item_id, item_description, action, detail, actor_email, actor_name)
     values ($1, $2, null, null, 'deposited', $3, $4, $5)`,
    [
      input.organizationId,
      input.propertyGroupId,
      `Removed a $${Math.round(Number(row.amount_usd)).toLocaleString("en-US")} deposit`,
      input.actorEmail,
      input.actorName,
    ]
  );
  return true;
}

/** Category breakdown of Actual (USD) spend — "a column that shows where
 * the balance is spent" (2026-08-20, Seni's ask). Only categories with real
 * spend recorded appear, biggest draw on the deposited balance first. */
export type ConstructionFundsCategorySpend = { category: string; spentUsd: number };

export async function getConstructionFundsSpendByCategory(
  organizationId: string,
  propertyGroupId: string
): Promise<ConstructionFundsCategorySpend[]> {
  const rows = await query<{ category: string; spent: string }>(
    `select category, sum(actual_usd) as spent
     from construction_budget_items
     where organization_id = $1 and property_group_id = $2 and actual_usd is not null and actual_usd <> 0
     group by category
     order by sum(actual_usd) desc`,
    [organizationId, propertyGroupId]
  );
  return rows.map((r) => ({ category: r.category, spentUsd: Number(r.spent) }));
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
