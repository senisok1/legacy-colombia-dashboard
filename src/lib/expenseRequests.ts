import { query, queryOne } from "./db";

// Team Expense Requests (2026-08-17, Seni's ask). See
// db/migrations/0028_expense_requests.sql. The whole flow in one sentence:
// a team member describes what they need and what it should cost, the owner
// ticks "Owner approved", and whoever buys it ticks "Completed" with the
// real amount — every step stamped with who and when.

export const EXPENSE_CATEGORIES = [
  "Maintenance & repairs",
  "Cleaning & supplies",
  "Guest experience",
  "Utilities",
  "Transport & fuel",
  "Staff & labor",
  "Other",
] as const;

export const URGENCIES = ["low", "normal", "urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];

export type ExpenseRequest = {
  id: string;
  propertyGroupId: string | null;
  title: string;
  description: string | null;
  descriptionOriginal: string | null;
  authorLanguage: string | null;
  category: string;
  estimatedAmount: number | null;
  currency: string;
  vendor: string | null;
  urgency: Urgency;
  neededBy: string | null;
  referenceUrl: string | null;
  requestedByEmail: string;
  requestedByName: string | null;
  requestedAt: string;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
  completed: boolean;
  completedByName: string | null;
  completedAt: string | null;
  actualAmount: number | null;
  editedAt: string | null;
  editedByName: string | null;
};

type Row = {
  id: string;
  property_group_id: string | null;
  title: string;
  description: string | null;
  description_original: string | null;
  author_language: string | null;
  category: string;
  estimated_amount: string | null;
  currency: string;
  vendor: string | null;
  urgency: string;
  needed_by: string | null;
  reference_url: string | null;
  requested_by_email: string;
  requested_by_name: string | null;
  requested_at: string | Date;
  approved: boolean;
  approved_by_name: string | null;
  approved_at: string | Date | null;
  declined: boolean;
  declined_reason: string | null;
  completed: boolean;
  completed_by_name: string | null;
  completed_at: string | Date | null;
  actual_amount: string | null;
  edited_at: string | Date | null;
  edited_by_name: string | null;
};

const COLUMNS = `id, property_group_id, title, description, description_original, author_language,
  category, estimated_amount, currency, vendor, urgency, needed_by, reference_url,
  requested_by_email, requested_by_name, requested_at,
  approved, approved_by_name, approved_at, declined, declined_reason,
  completed, completed_by_name, completed_at, actual_amount,
  edited_at, edited_by_name`;

function iso(v: string | Date | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

function fromRow(r: Row): ExpenseRequest {
  return {
    id: r.id,
    propertyGroupId: r.property_group_id,
    title: r.title,
    description: r.description,
    descriptionOriginal: r.description_original,
    authorLanguage: r.author_language,
    category: r.category,
    estimatedAmount: r.estimated_amount === null ? null : Number(r.estimated_amount),
    currency: r.currency,
    vendor: r.vendor,
    urgency: (URGENCIES as readonly string[]).includes(r.urgency) ? (r.urgency as Urgency) : "normal",
    neededBy: r.needed_by,
    referenceUrl: r.reference_url,
    requestedByEmail: r.requested_by_email,
    requestedByName: r.requested_by_name,
    requestedAt: iso(r.requested_at)!,
    approved: r.approved,
    approvedByName: r.approved_by_name,
    approvedAt: iso(r.approved_at),
    declined: r.declined,
    declinedReason: r.declined_reason,
    completed: r.completed,
    completedByName: r.completed_by_name,
    completedAt: iso(r.completed_at),
    actualAmount: r.actual_amount === null ? null : Number(r.actual_amount),
    editedAt: iso(r.edited_at),
    editedByName: r.edited_by_name,
  };
}

export async function listExpenseRequests(
  organizationId: string,
  propertyGroupId?: string
): Promise<ExpenseRequest[]> {
  const rows = await query<Row>(
    `select ${COLUMNS} from expense_requests
     where organization_id = $1
       and ($2::text is null or property_group_id is null or property_group_id = $2)
     order by requested_at desc
     limit 300`,
    [organizationId, propertyGroupId ?? null]
  );
  return rows.map(fromRow);
}

export async function createExpenseRequest(input: {
  organizationId: string;
  propertyGroupId?: string | null;
  title: string;
  description?: string | null;
  descriptionOriginal?: string | null;
  authorLanguage?: string | null;
  category?: string;
  estimatedAmount?: number | null;
  currency?: string;
  vendor?: string | null;
  urgency?: Urgency;
  neededBy?: string | null;
  referenceUrl?: string | null;
  requestedByEmail: string;
  requestedByName?: string | null;
}): Promise<ExpenseRequest> {
  const row = await queryOne<Row>(
    `insert into expense_requests
       (organization_id, property_group_id, title, description, description_original, author_language,
        category, estimated_amount, currency, vendor, urgency, needed_by, reference_url,
        requested_by_email, requested_by_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.propertyGroupId ?? null,
      input.title.trim(),
      input.description?.trim() || null,
      input.descriptionOriginal?.trim() || null,
      input.authorLanguage ?? null,
      input.category || "Other",
      input.estimatedAmount ?? null,
      input.currency || "USD",
      input.vendor?.trim() || null,
      input.urgency || "normal",
      input.neededBy || null,
      input.referenceUrl?.trim() || null,
      input.requestedByEmail,
      input.requestedByName ?? null,
    ]
  );
  if (!row) throw new Error("Failed to save the request.");
  return fromRow(row);
}

/** Owner approval / decline. Route-level guard restricts this to CEO logins;
 * the SQL is org-scoped so one tenant can never touch another's rows. */
export async function setApproval(input: {
  organizationId: string;
  id: string;
  approved: boolean;
  declined?: boolean;
  declinedReason?: string | null;
  byEmail: string;
  byName?: string | null;
}): Promise<ExpenseRequest | null> {
  const row = await queryOne<Row>(
    `update expense_requests set
       approved = $3,
       declined = $4,
       declined_reason = $5::text,
       approved_by_email = case when $3 or $4 then $6::text else null end,
       approved_by_name  = case when $3 or $4 then $7::text else null end,
       approved_at       = case when $3 or $4 then now() else null end
     where id = $2 and organization_id = $1
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.id,
      input.approved,
      input.declined ?? false,
      input.declinedReason ?? null,
      input.byEmail,
      input.byName ?? null,
    ]
  );
  return row ? fromRow(row) : null;
}

/** Mark done / undo. Completion date is stamped server-side (now()), never
 * taken from the client. */
export async function setCompleted(input: {
  organizationId: string;
  id: string;
  completed: boolean;
  actualAmount?: number | null;
  byEmail: string;
  byName?: string | null;
}): Promise<ExpenseRequest | null> {
  const row = await queryOne<Row>(
    `update expense_requests set
       completed = $3,
       -- BUG FIX (2026-08-17, Seni: ticking Completed instantly un-ticked
       -- itself): every one of these parameters sits ONLY inside a CASE
       -- whose other branch is a bare NULL, so Postgres had no way to infer
       -- their types and rejected the statement with "could not determine
       -- data type of parameter $4". The route returned 500, the client
       -- reloaded, and the checkbox snapped back to unchecked. Explicit
       -- casts give the planner the types it needs.
       actual_amount = case when $3 then $4::numeric else null end,
       completed_by_email = case when $3 then $5::text else null end,
       completed_by_name  = case when $3 then $6::text else null end,
       completed_at       = case when $3 then now() else null end
     where id = $2 and organization_id = $1
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.id,
      input.completed,
      input.actualAmount ?? null,
      input.byEmail,
      input.byName ?? null,
    ]
  );
  return row ? fromRow(row) : null;
}

/** Team-member edit of an existing request (2026-08-17, Seni's ask). Logs
 * who edited it and when. A request that had already been approved is
 * knocked back to unapproved — the owner signed off on the OLD numbers, so
 * a changed amount/scope has to be re-approved rather than silently
 * inheriting the old approval. Completed requests are never editable. */
export async function editExpenseRequest(input: {
  organizationId: string;
  id: string;
  title?: string;
  description?: string | null;
  descriptionOriginal?: string | null;
  authorLanguage?: string | null;
  category?: string;
  estimatedAmount?: number | null;
  currency?: string;
  vendor?: string | null;
  urgency?: Urgency;
  neededBy?: string | null;
  referenceUrl?: string | null;
  byEmail: string;
  byName?: string | null;
}): Promise<ExpenseRequest | null> {
  const sets: string[] = [];
  const values: unknown[] = [input.organizationId, input.id];
  const push = (col: string, cast: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}${cast}`);
  };

  if (input.title !== undefined) push("title", "::text", input.title.trim());
  if (input.description !== undefined) push("description", "::text", input.description);
  if (input.descriptionOriginal !== undefined)
    push("description_original", "::text", input.descriptionOriginal);
  if (input.authorLanguage !== undefined) push("author_language", "::text", input.authorLanguage);
  if (input.category !== undefined) push("category", "::text", input.category);
  if (input.estimatedAmount !== undefined) push("estimated_amount", "::numeric", input.estimatedAmount);
  if (input.currency !== undefined) push("currency", "::text", input.currency);
  if (input.vendor !== undefined) push("vendor", "::text", input.vendor);
  if (input.urgency !== undefined) push("urgency", "::text", input.urgency);
  if (input.neededBy !== undefined) push("needed_by", "::date", input.neededBy);
  if (input.referenceUrl !== undefined) push("reference_url", "::text", input.referenceUrl);
  if (sets.length === 0) return null;

  push("edited_by_email", "::text", input.byEmail);
  push("edited_by_name", "::text", input.byName ?? null);
  sets.push("edited_at = now()");
  // Re-approval required after an edit.
  sets.push("approved = false", "declined = false", "approved_at = null", "approved_by_name = null");

  const row = await queryOne<Row>(
    `update expense_requests set ${sets.join(", ")}
     where id = $2 and organization_id = $1 and completed = false
     returning ${COLUMNS}`,
    values
  );
  return row ? fromRow(row) : null;
}

export async function deleteExpenseRequest(
  organizationId: string,
  id: string
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from expense_requests where id = $1 and organization_id = $2 returning id`,
    [id, organizationId]
  );
  return rows.length > 0;
}
