import { query, queryOne } from "./db";
import { sumByCurrency, type CurrencyTotal } from "./currencyTotals";

// Monthly recurring bills checklist (2026-08-17, Seni's ask). See
// db/migrations/0027_recurring_bills.sql for why "paid" is modelled as the
// PRESENCE of a payment row rather than a boolean column: it makes the
// month-to-month roll-forward a read-time computation with no scheduled job
// that could silently fail and lose an unpaid bill.

export type RecurringBill = {
  id: string;
  propertyGroupId: string | null;
  name: string;
  amount: number | null;
  currency: string;
  dueDay: number | null;
  startPeriod: string;
  notes: string | null;
  active: boolean;
};

export type BillPayment = {
  recurringBillId: string;
  period: string;
  amountPaid: number | null;
  paidAt: string;
  paidByName: string | null;
  paidByEmail: string | null;
};

/** One line the owner ticks off: a bill in a specific month. */
export type BillDue = {
  billId: string;
  name: string;
  amount: number | null;
  currency: string;
  dueDay: number | null;
  /** 'YYYY-MM' this line belongs to. */
  period: string;
  /** Human label, e.g. "July 2026". */
  periodLabel: string;
  /** True when this is an unpaid line rolled forward from an earlier month. */
  carriedOver: boolean;
  paid: boolean;
  paidAt: string | null;
  paidByName: string | null;
  notes: string | null;
};

type BillRow = {
  id: string;
  property_group_id: string | null;
  name: string;
  amount: string | null;
  currency: string;
  due_day: number | null;
  start_period: string;
  notes: string | null;
  active: boolean;
};

type PaymentRow = {
  recurring_bill_id: string;
  period: string;
  amount_paid: string | null;
  paid_at: string | Date;
  paid_by_name: string | null;
  paid_by_email: string | null;
};

function billFromRow(r: BillRow): RecurringBill {
  return {
    id: r.id,
    propertyGroupId: r.property_group_id,
    name: r.name,
    amount: r.amount === null ? null : Number(r.amount),
    currency: r.currency,
    dueDay: r.due_day,
    startPeriod: r.start_period,
    notes: r.notes,
    active: r.active,
  };
}

/** 'YYYY-MM' for a Date (UTC — periods are calendar labels, not instants). */
export function periodOf(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Every 'YYYY-MM' from `from` through `to`, inclusive. Capped at 24 so a
 * bad start_period can never produce an unbounded list.
 *
 * BUG FIX (2026-08-17 audit): the cap used to stop the loop after 24 entries
 * counting FORWARD from `from`, which silently dropped the far end of the
 * range — the CURRENT month. A bill whose start_period was 24+ months ago
 * (any bill set up two years ago, or one created with a mistyped start year
 * like "2019-01") produced lines only for 2019, never for today, so it
 * vanished from the Bill Pay board entirely and could not be ticked paid.
 * The board looked complete while a real monthly bill was missing from it.
 *
 * The cap now keeps the MOST RECENT 24 periods instead of the first 24: the
 * current month is always present, and it's the oldest carryovers — the ones
 * least likely to still be actionable — that get trimmed. */
export function periodsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  if (!fy || !fm || !ty || !tm) return [to];
  const MAX_PERIODS = 24;
  // Month indices rather than a while-loop, so the cap is applied to the START
  // of the range up front. Looping and trimming afterwards would still need an
  // iteration guard, and any such guard would re-introduce exactly the bug
  // above for a nonsense start_period (year 1900 → guard trips → current month
  // dropped again). This way the loop runs at most MAX_PERIODS times no matter
  // what start_period contains, and `to` is always the final entry.
  const fromIdx = fy * 12 + (fm - 1);
  const toIdx = ty * 12 + (tm - 1);
  if (toIdx < fromIdx) return [to];
  const startIdx = Math.max(fromIdx, toIdx - (MAX_PERIODS - 1));
  const out: string[] = [];
  for (let idx = startIdx; idx <= toIdx; idx++) {
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out.length > 0 ? out : [to];
}

export async function listRecurringBills(
  organizationId: string,
  propertyGroupId?: string
): Promise<RecurringBill[]> {
  const rows = await query<BillRow>(
    `select id, property_group_id, name, amount, currency, due_day, start_period, notes, active
     from recurring_bills
     where organization_id = $1
       and ($2::text is null or property_group_id is null or property_group_id = $2)
     order by active desc, lower(name)`,
    [organizationId, propertyGroupId ?? null]
  );
  return rows.map(billFromRow);
}

export async function createRecurringBill(input: {
  organizationId: string;
  propertyGroupId?: string | null;
  name: string;
  amount?: number | null;
  currency?: string;
  dueDay?: number | null;
  startPeriod?: string;
  notes?: string | null;
}): Promise<RecurringBill> {
  const row = await queryOne<BillRow>(
    `insert into recurring_bills
       (organization_id, property_group_id, name, amount, currency, due_day, start_period, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, property_group_id, name, amount, currency, due_day, start_period, notes, active`,
    [
      input.organizationId,
      input.propertyGroupId ?? null,
      input.name.trim(),
      input.amount ?? null,
      input.currency ?? "USD",
      input.dueDay ?? null,
      input.startPeriod ?? periodOf(),
      input.notes?.trim() || null,
    ]
  );
  if (!row) throw new Error("Failed to create the recurring bill.");
  return billFromRow(row);
}

export async function updateRecurringBill(
  id: string,
  organizationId: string,
  fields: {
    name?: string;
    amount?: number | null;
    currency?: string;
    dueDay?: number | null;
    notes?: string | null;
    active?: boolean;
    propertyGroupId?: string | null;
  }
): Promise<RecurringBill | null> {
  const sets: string[] = [];
  const values: unknown[] = [id, organizationId];
  const push = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (fields.name !== undefined) push("name", fields.name.trim());
  if (fields.amount !== undefined) push("amount", fields.amount);
  if (fields.currency !== undefined) push("currency", fields.currency);
  if (fields.dueDay !== undefined) push("due_day", fields.dueDay);
  if (fields.notes !== undefined) push("notes", fields.notes);
  if (fields.active !== undefined) push("active", fields.active);
  if (fields.propertyGroupId !== undefined) push("property_group_id", fields.propertyGroupId);
  if (sets.length === 0) return null;

  const row = await queryOne<BillRow>(
    `update recurring_bills set ${sets.join(", ")}
     where id = $1 and organization_id = $2
     returning id, property_group_id, name, amount, currency, due_day, start_period, notes, active`,
    values
  );
  return row ? billFromRow(row) : null;
}

export async function deleteRecurringBill(id: string, organizationId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from recurring_bills where id = $1 and organization_id = $2 returning id`,
    [id, organizationId]
  );
  return rows.length > 0;
}

/** Tick a bill paid for one month. Idempotent — re-ticking updates nothing
 * and returns cleanly (the unique constraint makes this safe under a double
 * click). */
export async function markBillPaid(input: {
  organizationId: string;
  billId: string;
  period: string;
  amountPaid?: number | null;
  paidByEmail?: string | null;
  paidByName?: string | null;
  note?: string | null;
}): Promise<void> {
  await query(
    `insert into recurring_bill_payments
       (organization_id, recurring_bill_id, period, amount_paid, paid_by_email, paid_by_name, note)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (recurring_bill_id, period) do nothing`,
    [
      input.organizationId,
      input.billId,
      input.period,
      input.amountPaid ?? null,
      input.paidByEmail ?? null,
      input.paidByName ?? null,
      input.note ?? null,
    ]
  );
}

/** Un-tick a bill for one month (mis-click / reversed payment). */
export async function markBillUnpaid(
  organizationId: string,
  billId: string,
  period: string
): Promise<void> {
  await query(
    `delete from recurring_bill_payments
     where organization_id = $1 and recurring_bill_id = $2 and period = $3`,
    [organizationId, billId, period]
  );
}

export type RecurringBillsBoard = {
  /** 'YYYY-MM' currently being worked on. */
  period: string;
  periodLabel: string;
  /** This month's lines, plus any unpaid lines rolled forward from earlier. */
  dues: BillDue[];
  outstandingCount: number;
  /** Outstanding money owed, split per currency — NOT one number. Bills can
   * be in COP and USD at the same time; see the 2026-08-17 fix note where
   * this is computed. */
  outstandingTotals: CurrencyTotal[];
  /** True when every line (this month + carryovers) is ticked. */
  allPaid: boolean;
  /** Ready-made banner text, e.g. "All July bills paid". */
  summary: string;
  bills: RecurringBill[];
};

/** The checklist the Bill Pay tab renders.
 *
 * Roll-forward rule (Seni's spec): show every active bill for the CURRENT
 * month, and additionally show any month from the bill's start_period up to
 * last month that still has no payment row — those appear as carried-over
 * lines rather than silently disappearing when the month flips. */
export async function getRecurringBillsBoard(
  organizationId: string,
  propertyGroupId?: string,
  now: Date = new Date()
): Promise<RecurringBillsBoard> {
  const period = periodOf(now);
  const bills = await listRecurringBills(organizationId, propertyGroupId);
  const active = bills.filter((b) => b.active);

  const payments = await query<PaymentRow>(
    `select recurring_bill_id, period, amount_paid, paid_at, paid_by_name, paid_by_email
     from recurring_bill_payments
     where organization_id = $1`,
    [organizationId]
  );
  const paidKeys = new Map<string, PaymentRow>();
  for (const p of payments) paidKeys.set(`${p.recurring_bill_id}:${p.period}`, p);

  const dues: BillDue[] = [];
  for (const b of active) {
    // BUG FIX (2026-08-17 audit): this used to CLAMP a future start_period
    // down to the current month —
    //     const start = b.startPeriod > period ? period : b.startPeriod;
    // — which meant a bill that doesn't start until, say, October appeared as
    // due RIGHT NOW the moment it was created. The owner sees a bill demanding
    // payment months before the contract begins, and ticking it paid writes a
    // payment row for a month the bill didn't exist in.
    //
    // A bill simply must not appear before its start period, so skip it
    // entirely until the calendar reaches that month.
    if (b.startPeriod > period) continue;
    // Never look further back than the bill's own start month.
    const start = b.startPeriod;
    for (const p of periodsBetween(start, period)) {
      const hit = paidKeys.get(`${b.id}:${p}`);
      const isCurrent = p === period;
      // Past months only appear while still unpaid — a settled July line
      // shouldn't clutter August.
      if (!isCurrent && hit) continue;
      dues.push({
        billId: b.id,
        name: b.name,
        amount: b.amount,
        currency: b.currency,
        dueDay: b.dueDay,
        period: p,
        periodLabel: periodLabel(p),
        carriedOver: !isCurrent,
        paid: Boolean(hit),
        paidAt: hit ? new Date(hit.paid_at).toISOString() : null,
        paidByName: hit?.paid_by_name ?? null,
        notes: b.notes,
      });
    }
  }

  // Oldest unpaid first, then this month's list alphabetically.
  dues.sort((a, b) =>
    a.period === b.period ? a.name.localeCompare(b.name) : a.period.localeCompare(b.period)
  );

  const outstanding = dues.filter((d) => !d.paid);
  // BUG FIX (2026-08-17 audit): this used to be a single
  //     outstanding.reduce((sum, d) => sum + (d.amount ?? 0), 0)
  // summed across bills whose `currency` differs — the board renders each
  // line's own currency correctly, but the rollup threw it away, and
  // RecurringBills.tsx then printed the number as USD. One COP utility bill
  // (say 800,000 COP ≈ $200) made "outstanding" read $800,450 instead of
  // ~$650. See src/lib/currencyTotals.ts for the full rationale on why we
  // group by currency instead of converting.
  const outstandingTotals = sumByCurrency(
    outstanding,
    (d) => d.amount,
    (d) => d.currency
  );
  const allPaid = dues.length > 0 && outstanding.length === 0;

  const summary = allPaid
    ? `All ${periodLabel(period)} bills paid`
    : dues.length === 0
      ? "No recurring bills set up yet."
      : `${outstanding.length} bill${outstanding.length === 1 ? "" : "s"} still to pay${
          outstanding.some((d) => d.carriedOver)
            ? ` (including ${outstanding.filter((d) => d.carriedOver).length} carried over)`
            : ""
        }`;

  return {
    period,
    periodLabel: periodLabel(period),
    dues,
    outstandingCount: outstanding.length,
    outstandingTotals,
    allPaid,
    summary,
    bills,
  };
}
