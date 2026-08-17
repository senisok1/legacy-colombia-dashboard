import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  createRecurringBill,
  deleteRecurringBill,
  getRecurringBillsBoard,
  markBillPaid,
  markBillUnpaid,
  periodOf,
  updateRecurringBill,
} from "@/lib/recurringBills";

export const dynamic = "force-dynamic";

// Monthly recurring-bills checklist (2026-08-17, Seni's ask) — read + write
// for the Bill Pay tab's new "Monthly recurring bills" section.
//
//   GET                          → the current month's board (+ carryovers)
//   POST   {name, amount, …}     → add a recurring bill
//   PATCH  {billId, period, paid}→ tick / untick one month
//   PUT    {billId, …}           → edit or deactivate a bill
//   DELETE {billId}              → remove it entirely
//
// Writes are admin-only: a READ_ONLY team login is already blocked from
// every non-GET /api/* call except the Management allowlist in src/proxy.ts,
// and /bill-pay is not in the team-blocked page list, so the team can still
// SEE what's outstanding without being able to tick anything off.

async function context(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  const me = await getUserByEmail(session.email).catch(() => null);
  const groupId = effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    me?.propertyAccess
  );
  return { session, me, groupId };
}

export async function GET(req: NextRequest) {
  const { session, groupId, error } = await context(req);
  if (error) return error;
  try {
    const board = await getRecurringBillsBoard(session.organizationId, groupId);
    return NextResponse.json(board);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { session, groupId, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as {
    name?: string;
    amount?: number | string | null;
    currency?: string;
    dueDay?: number | string | null;
    startPeriod?: string;
    notes?: string;
    allProperties?: boolean;
  } | null;

  const name = body?.name?.trim();
  if (!name) return NextResponse.json({ error: "Give the bill a name." }, { status: 400 });

  const amount =
    body?.amount === null || body?.amount === undefined || body.amount === "" ? null : Number(body.amount);
  if (amount !== null && !Number.isFinite(amount)) {
    return NextResponse.json({ error: "Amount must be a number." }, { status: 400 });
  }
  const dueDayRaw =
    body?.dueDay === null || body?.dueDay === undefined || body.dueDay === "" ? null : Number(body.dueDay);
  if (dueDayRaw !== null && (!Number.isInteger(dueDayRaw) || dueDayRaw < 1 || dueDayRaw > 31)) {
    return NextResponse.json({ error: "Due day must be between 1 and 31." }, { status: 400 });
  }

  try {
    const bill = await createRecurringBill({
      organizationId: session.organizationId,
      // Default to the property currently being viewed; allProperties pins it
      // to every property view instead.
      propertyGroupId: body?.allProperties ? null : groupId,
      name,
      amount,
      currency: body?.currency || "USD",
      dueDay: dueDayRaw,
      startPeriod: /^\d{4}-\d{2}$/.test(body?.startPeriod ?? "") ? body!.startPeriod : periodOf(),
      notes: body?.notes ?? null,
    });
    return NextResponse.json({ ok: true, bill });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const { session, me, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | { billId?: string; period?: string; paid?: boolean; amountPaid?: number | null }
    | null;
  if (!body?.billId || !body.period || typeof body.paid !== "boolean") {
    return NextResponse.json({ error: "billId, period and paid are required." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(body.period)) {
    return NextResponse.json({ error: "period must look like 2026-08." }, { status: 400 });
  }

  try {
    if (body.paid) {
      await markBillPaid({
        organizationId: session.organizationId,
        billId: body.billId,
        period: body.period,
        amountPaid: body.amountPaid ?? null,
        paidByEmail: session.email,
        paidByName: me?.name ?? null,
      });
    } else {
      await markBillUnpaid(session.organizationId, body.billId, body.period);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const { session, groupId, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | {
        billId?: string;
        name?: string;
        amount?: number | string | null;
        currency?: string;
        dueDay?: number | string | null;
        notes?: string | null;
        active?: boolean;
        /** true = show under every property; false = pin to the current one. */
        allProperties?: boolean;
      }
    | null;
  if (!body?.billId) return NextResponse.json({ error: "billId is required." }, { status: 400 });

  try {
    const updated = await updateRecurringBill(body.billId, session.organizationId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.amount !== undefined
        ? { amount: body.amount === null || body.amount === "" ? null : Number(body.amount) }
        : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.dueDay !== undefined
        ? { dueDay: body.dueDay === null || body.dueDay === "" ? null : Number(body.dueDay) }
        : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.allProperties !== undefined
        ? { propertyGroupId: body.allProperties ? null : groupId }
        : {}),
    });
    if (!updated) return NextResponse.json({ error: "No such bill." }, { status: 404 });
    return NextResponse.json({ ok: true, bill: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { session, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { billId?: string } | null;
  if (!body?.billId) return NextResponse.json({ error: "billId is required." }, { status: 400 });

  try {
    const ok = await deleteRecurringBill(body.billId, session.organizationId);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "No such bill." }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
