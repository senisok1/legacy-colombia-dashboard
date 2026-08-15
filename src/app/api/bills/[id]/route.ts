import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { updateBillStatus, updateBillFields } from "@/lib/billPay";
import { getSessionFromRequest } from "@/lib/session";
import type { BillStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_STATUSES: BillStatus[] = [
  "pending_review",
  "flagged_duplicate",
  "flagged_anomaly",
  "approved_for_payment",
  "paid_manually",
  "rejected",
];

// Two independent kinds of edit, both status-free of any payment action —
// see lib/billPay.ts's header comment. Send either or both in one request:
//   { status: "..." }                     -> updateBillStatus (the approval surface)
//   { fields: { amountCents, ... } }       -> updateBillFields (correcting a
//                                             wrong AI extraction or typo —
//                                             see lib/billForward.ts)
// There is no endpoint anywhere in this app that executes a payment;
// "approved_for_payment" and "paid_manually" are both just Seni recording a
// decision/action he made himself outside this system.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || (!body.status && !body.fields)) {
    return NextResponse.json({ error: "Provide a status and/or fields to update." }, { status: 400 });
  }

  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }

  if (body.fields) {
    const fieldsResult = await updateBillFields(id, body.fields, session?.organizationId);
    if (!fieldsResult) return NextResponse.json({ error: "Bill not found." }, { status: 404 });
    if (!body.status) return NextResponse.json({ bill: fieldsResult });
  }

  const bill = await updateBillStatus(
    id,
    { status: body.status, reviewNotes: body.reviewNotes },
    session?.organizationId
  );
  if (!bill) return NextResponse.json({ error: "Bill not found." }, { status: 404 });
  return NextResponse.json({ bill });
}
