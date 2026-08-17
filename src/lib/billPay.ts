import { query, queryOne, propertyGroupFilter } from "./db";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import type { Bill, BillStatus, Vendor } from "./types";

// Phase 4 of the Legacy AI Company roadmap (docs/VISION.md) — Bill Pay +
// Vendor management, TRACKING/DETECTION ONLY. Nothing in this file ever
// sends money, schedules a payment, or reads payment_notes/contact fields
// for anything other than displaying them to Seni. "approved_for_payment"
// means Seni has decided to pay it himself outside this system; the flow
// ends there until a future phase turns on real payment scheduling (with
// its own separate, much stricter approval gate per VISION.md).

const AGENT_KEY = "bill_pay";
const AGENT_NAME = "AI Bill Pay & Accounts Payable Manager";

// A new bill within this many days of an existing one, same vendor and same
// amount, is treated as a likely duplicate (someone re-forwarded the same
// invoice, or a vendor double-billed). Deliberately generous — false
// positives here just mean an extra human glance, which is the point.
const DUPLICATE_WINDOW_DAYS = 10;

// ---------- Vendors ----------

type VendorRow = {
  id: string;
  name: string;
  category: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  payment_notes: string | null;
  default_property_id: string | null;
  notes: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function fromVendorRow(row: VendorRow): Vendor {
  return {
    id: row.id,
    name: row.name,
    category: row.category ?? undefined,
    contactName: row.contact_name ?? undefined,
    contactEmail: row.contact_email ?? undefined,
    contactPhone: row.contact_phone ?? undefined,
    paymentNotes: row.payment_notes ?? undefined,
    defaultPropertyId: row.default_property_id ?? undefined,
    notes: row.notes ?? undefined,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listVendors(organizationId?: string, propertyGroupId?: string): Promise<Vendor[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<VendorRow>(
    `select * from vendors where organization_id = $1${propertyGroupFilter(propertyGroupId, 2)} order by name asc`,
    propertyGroupId ? [orgId, propertyGroupId] : [orgId]
  );
  return rows.map(fromVendorRow);
}

export async function getVendor(id: string, organizationId?: string): Promise<Vendor | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<VendorRow>("select * from vendors where id = $1 and organization_id = $2", [id, orgId]);
  return row ? fromVendorRow(row) : null;
}

export async function createVendor(
  input: {
    name: string;
    category?: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    paymentNotes?: string;
    defaultPropertyId?: string;
    notes?: string;
  },
  organizationId?: string,
  // Stamped so the vendor only appears under the property it was created
  // for (2026-08-17). Undefined leaves it NULL = visible under the default
  // group, matching every pre-existing row.
  propertyGroupId?: string
): Promise<Vendor> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<VendorRow>(
    `insert into vendors (organization_id, name, category, contact_name, contact_email, contact_phone, payment_notes, default_property_id, notes, property_group_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      orgId,
      input.name,
      input.category ?? null,
      input.contactName ?? null,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
      input.paymentNotes ?? null,
      input.defaultPropertyId ?? null,
      input.notes ?? null,
      propertyGroupId ?? null,
    ]
  );
  if (!row) throw new Error("Failed to create vendor.");
  return fromVendorRow(row);
}

/**
 * Resolves a vendor name (as read off a forwarded bill, see billExtract.ts)
 * to an existing vendor, or creates a new one if nothing matches closely
 * enough. Only ever creates a plain tracking record — never anything
 * payment-related — so auto-creating here carries none of the risk VISION.md
 * flags around new vendors (that's specifically about money movement, which
 * this app never does). The bill itself still lands in pending_review
 * regardless, so a wrong auto-match still gets a human look.
 */
export async function findOrCreateVendorByName(
  name: string,
  organizationId?: string
): Promise<{ vendor: Vendor; created: boolean }> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const trimmed = name.trim();
  const exact = await queryOne<VendorRow>(
    "select * from vendors where organization_id = $1 and lower(name) = lower($2) limit 1",
    [orgId, trimmed]
  );
  if (exact) return { vendor: fromVendorRow(exact), created: false };

  const loose = await queryOne<VendorRow>(
    "select * from vendors where organization_id = $1 and lower(name) like lower($2) limit 1",
    [orgId, `%${trimmed}%`]
  );
  if (loose) return { vendor: fromVendorRow(loose), created: false };

  const vendor = await createVendor(
    {
      name: trimmed,
      notes: "Auto-created from a WhatsApp invoice forward — please verify details.",
    },
    orgId
  );
  return { vendor, created: true };
}

export async function updateVendor(
  id: string,
  updates: Partial<{
    name: string;
    category: string;
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    paymentNotes: string;
    defaultPropertyId: string;
    notes: string;
    active: boolean;
  }>,
  organizationId?: string
): Promise<Vendor | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const existing = await getVendor(id, orgId);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  const row = await queryOne<VendorRow>(
    `update vendors set
       name = $2, category = $3, contact_name = $4, contact_email = $5, contact_phone = $6,
       payment_notes = $7, default_property_id = $8, notes = $9, active = $10, updated_at = now()
     where id = $1 and organization_id = $11
     returning *`,
    [
      id,
      merged.name,
      merged.category ?? null,
      merged.contactName ?? null,
      merged.contactEmail ?? null,
      merged.contactPhone ?? null,
      merged.paymentNotes ?? null,
      merged.defaultPropertyId ?? null,
      merged.notes ?? null,
      merged.active,
      orgId,
    ]
  );
  return row ? fromVendorRow(row) : null;
}

// ---------- Bills ----------

type BillRow = {
  id: string;
  vendor_id: string;
  vendor_name?: string;
  property_id: string | null;
  invoice_number: string | null;
  amount_cents: number;
  currency: string;
  category: string | null;
  invoice_date: string | null;
  due_date: string | null;
  source: Bill["source"];
  source_reference: string | null;
  attachment_url: string | null;
  status: BillStatus;
  duplicate_of_bill_id: string | null;
  flag_reason: string | null;
  confidence_score: number | null;
  reviewed_by_id: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  created_at: Date;
  updated_at: Date;
};

function fromBillRow(row: BillRow): Bill {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name ?? undefined,
    propertyId: row.property_id ?? undefined,
    invoiceNumber: row.invoice_number ?? undefined,
    amountCents: row.amount_cents,
    currency: row.currency,
    category: row.category ?? undefined,
    invoiceDate: row.invoice_date ?? undefined,
    dueDate: row.due_date ?? undefined,
    source: row.source,
    sourceReference: row.source_reference ?? undefined,
    attachmentUrl: row.attachment_url ?? undefined,
    status: row.status,
    duplicateOfBillId: row.duplicate_of_bill_id ?? undefined,
    flagReason: row.flag_reason ?? undefined,
    confidenceScore: row.confidence_score ?? undefined,
    reviewedById: row.reviewed_by_id ?? undefined,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : undefined,
    reviewNotes: row.review_notes ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Every bill, newest first, with the vendor name joined in so the UI never
 * needs a second round trip per row. */
export async function listBills(organizationId?: string, propertyGroupId?: string): Promise<Bill[]> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const rows = await query<BillRow>(
    `select b.*, v.name as vendor_name
     from bills b
     join vendors v on v.id = b.vendor_id
     where b.organization_id = $1${propertyGroupFilter(propertyGroupId, 2, "b.property_group_id")}
     order by b.created_at desc`,
    propertyGroupId ? [orgId, propertyGroupId] : [orgId]
  );
  return rows.map(fromBillRow);
}

export async function getBill(id: string, organizationId?: string): Promise<Bill | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<BillRow>(
    `select b.*, v.name as vendor_name from bills b join vendors v on v.id = b.vendor_id where b.id = $1 and b.organization_id = $2`,
    [id, orgId]
  );
  return row ? fromBillRow(row) : null;
}

/** Looks for an existing bill that's suspiciously close to the one about to
 * be created — same vendor and same amount within DUPLICATE_WINDOW_DAYS of
 * each other's invoice date, or same vendor and same non-empty invoice
 * number. Either signal alone is enough to flag; this errs toward "ask a
 * human" rather than silently accepting a possible double-bill. */
async function findLikelyDuplicate(
  input: {
    vendorId: string;
    amountCents: number;
    invoiceNumber?: string;
    invoiceDate?: string;
  },
  organizationId: string
): Promise<Bill | null> {
  if (input.invoiceNumber) {
    const byNumber = await queryOne<BillRow>(
      `select b.*, v.name as vendor_name from bills b join vendors v on v.id = b.vendor_id
       where b.organization_id = $1 and b.vendor_id = $2 and b.invoice_number = $3 and b.status != 'rejected'
       order by b.created_at desc limit 1`,
      [organizationId, input.vendorId, input.invoiceNumber]
    );
    if (byNumber) return fromBillRow(byNumber);
  }

  const byAmount = await queryOne<BillRow>(
    `select b.*, v.name as vendor_name from bills b join vendors v on v.id = b.vendor_id
     where b.organization_id = $1 and b.vendor_id = $2 and b.amount_cents = $3 and b.status != 'rejected'
       and ($4::date is null or b.invoice_date is null or abs(b.invoice_date - $4::date) <= $5)
     order by b.created_at desc limit 1`,
    [organizationId, input.vendorId, input.amountCents, input.invoiceDate ?? null, DUPLICATE_WINDOW_DAYS]
  );
  return byAmount ? fromBillRow(byAmount) : null;
}

export async function createBill(
  input: {
    vendorId: string;
    propertyId?: string;
    invoiceNumber?: string;
    amountCents: number;
    currency?: string;
    category?: string;
    invoiceDate?: string;
    dueDate?: string;
    source?: Bill["source"];
    sourceReference?: string;
    attachmentUrl?: string;
  },
  organizationId?: string,
  propertyGroupId?: string
): Promise<Bill> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const duplicate = await findLikelyDuplicate(
    {
      vendorId: input.vendorId,
      amountCents: input.amountCents,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
    },
    orgId
  );

  const status: BillStatus = duplicate ? "flagged_duplicate" : "pending_review";
  const flagReason = duplicate
    ? `Looks like it may be a duplicate of a bill from ${duplicate.createdAt.slice(0, 10)} for the same vendor` +
      (duplicate.invoiceNumber && duplicate.invoiceNumber === input.invoiceNumber
        ? ` (same invoice number ${input.invoiceNumber})`
        : ` (same amount, within ${DUPLICATE_WINDOW_DAYS} days)`)
    : null;

  const row = await queryOne<BillRow>(
    `insert into bills
       (organization_id, vendor_id, property_id, invoice_number, amount_cents, currency, category,
        invoice_date, due_date, source, source_reference, attachment_url,
        status, duplicate_of_bill_id, flag_reason, property_group_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning *, (select name from vendors where id = $2) as vendor_name`,
    [
      orgId,
      input.vendorId,
      input.propertyId ?? null,
      input.invoiceNumber ?? null,
      input.amountCents,
      input.currency ?? "USD",
      input.category ?? null,
      input.invoiceDate ?? null,
      input.dueDate ?? null,
      input.source ?? "manual",
      input.sourceReference ?? null,
      input.attachmentUrl ?? null,
      status,
      duplicate?.id ?? null,
      flagReason,
      propertyGroupId ?? null,
    ]
  );
  if (!row) throw new Error("Failed to create bill.");
  const bill = fromBillRow(row);

  if (duplicate) {
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Flag possible duplicate bill",
      trigger: `New bill entered for vendor ${bill.vendorName ?? bill.vendorId}, amount ${(bill.amountCents / 100).toFixed(2)} ${bill.currency}`,
      dataReviewed: { newBillId: bill.id, existingBillId: duplicate.id },
      decision: flagReason ?? "flagged as possible duplicate",
      actionTaken: "Marked new bill flagged_duplicate for Seni to review — nothing scheduled, no payment affected",
      result: "flagged_duplicate",
    }).catch(() => {});
  } else {
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Log new bill",
      trigger: `New bill entered for vendor ${bill.vendorName ?? bill.vendorId}`,
      decision: "no duplicate found — queued for review",
      actionTaken: "Created bill record, status pending_review",
      result: "pending_review",
    }).catch(() => {});
  }

  return bill;
}

/** Status transitions only — this is the entire "approval" surface for
 * bills. Nothing this function can set ever triggers an actual payment;
 * approved_for_payment and paid_manually are both just record-keeping about
 * a decision/action Seni made himself outside this system. */
export async function updateBillStatus(
  id: string,
  update: { status: BillStatus; reviewNotes?: string; reviewedById?: string },
  organizationId?: string
): Promise<Bill | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const row = await queryOne<BillRow>(
    `update bills set
       status = $2, review_notes = coalesce($3, review_notes),
       reviewed_by_id = coalesce($4, reviewed_by_id), reviewed_at = now(), updated_at = now()
     where id = $1 and organization_id = $5
     returning *, (select name from vendors where id = bills.vendor_id) as vendor_name`,
    [id, update.status, update.reviewNotes ?? null, update.reviewedById ?? null, orgId]
  );
  if (!row) return null;
  const bill = fromBillRow(row);

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Update bill status",
    trigger: `Seni set bill ${id} (${bill.vendorName ?? bill.vendorId}) to ${update.status}`,
    decision: update.status,
    actionTaken:
      update.status === "approved_for_payment"
        ? "Marked approved for payment — Seni still pays this himself outside the system"
        : update.status === "paid_manually"
          ? "Marked paid — record-keeping only, no payment was sent by this system"
          : `Status changed to ${update.status}`,
    result: update.status,
  }).catch(() => {});

  return bill;
}

/** Corrects the extracted/entered fields on a bill (amount, vendor, dates,
 * etc.) — separate from updateBillStatus so the Bill Pay UI can let Seni fix
 * a wrong AI extraction (see billForward.ts) without that edit looking like
 * a status decision in the AI Activity log. Never touches status itself. */
export async function updateBillFields(
  id: string,
  updates: Partial<{
    vendorId: string;
    amountCents: number;
    currency: string;
    invoiceNumber: string;
    category: string;
    invoiceDate: string;
    dueDate: string;
  }>,
  organizationId?: string
): Promise<Bill | null> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const existing = await getBill(id, orgId);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  const row = await queryOne<BillRow>(
    `update bills set
       vendor_id = $2, amount_cents = $3, currency = $4, invoice_number = $5,
       category = $6, invoice_date = $7, due_date = $8, updated_at = now()
     where id = $1 and organization_id = $9
     returning *, (select name from vendors where id = bills.vendor_id) as vendor_name`,
    [
      id,
      merged.vendorId,
      merged.amountCents,
      merged.currency,
      merged.invoiceNumber ?? null,
      merged.category ?? null,
      merged.invoiceDate ?? null,
      merged.dueDate ?? null,
      orgId,
    ]
  );
  return row ? fromBillRow(row) : null;
}
