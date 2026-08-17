import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { translateText } from "@/lib/translate";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  createExpenseRequest,
  deleteExpenseRequest,
  editExpenseRequest,
  listExpenseRequests,
  setApproval,
  setCompleted,
  URGENCIES,
  type Urgency,
} from "@/lib/expenseRequests";

export const dynamic = "force-dynamic";

// Team Expense Requests (2026-08-17, Seni's ask).
//
//   GET                                   → every request for this property
//   POST   {title, description, …}        → any logged-in user may request
//   POST   {id, title, …}                 → EDIT an existing request
//   PATCH  {id, approved|declined}        → OWNER (CEO) ONLY
//   PUT    {id, completed, actualAmount}  → anyone may mark it done
//   DELETE {id}                           → the requester or an owner
//
// POST and PUT are allowlisted for READ_ONLY sessions in src/proxy.ts — the
// whole point is that the on-site team raises and closes these themselves.
// PATCH deliberately is NOT: approval is the owner's decision, and the CEO
// check below is the real gate (proxy allowlisting only controls whether a
// team session may reach the route at all).

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
    const requests = await listExpenseRequests(session.organizationId, groupId);
    return NextResponse.json({
      requests,
      viewerIsOwner: session.role === "CEO",
      viewerEmail: session.email,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { session, me, groupId, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as {
    /** Present = edit that request instead of creating a new one. */
    id?: string;
    title?: string;
    description?: string;
    category?: string;
    estimatedAmount?: string | number | null;
    currency?: string;
    vendor?: string;
    urgency?: string;
    neededBy?: string;
    referenceUrl?: string;
  } | null;

  const title = body?.title?.trim();
  if (!title) return NextResponse.json({ error: "Say what the expense is for." }, { status: 400 });
  if (title.length > 200) return NextResponse.json({ error: "Keep the title under 200 characters." }, { status: 400 });

  const raw = body?.estimatedAmount;
  const estimatedAmount = raw === "" || raw === null || raw === undefined ? null : Number(raw);
  if (estimatedAmount !== null && (!Number.isFinite(estimatedAmount) || estimatedAmount < 0)) {
    return NextResponse.json({ error: "Estimated cost must be a positive number." }, { status: 400 });
  }

  const urgency: Urgency = (URGENCIES as readonly string[]).includes(body?.urgency ?? "")
    ? (body!.urgency as Urgency)
    : "normal";

  // Same language handling as Management notes: a Spanish/Portuguese
  // teammate writes in their own language, the owner reads English, and the
  // original text is kept so nothing they wrote is lost. Translation failure
  // is non-fatal — the original becomes the stored description.
  const authorLanguage = me?.language || "English";
  const typed = body?.description?.trim() || "";
  let description = typed;
  let descriptionOriginal: string | null = null;
  if (typed && authorLanguage.toLowerCase() !== "english") {
    descriptionOriginal = typed;
    try {
      const res = await translateText(typed, "en", session.organizationId);
      if (res.ok && res.text.trim()) description = res.text.trim();
    } catch (err) {
      console.error("[team-expenses] translation to English failed:", err);
      description = typed;
    }
  }

  try {
    // Edit path (2026-08-17, Seni's ask) — same validation and translation
    // as a new request. editExpenseRequest() stamps edited_by/edited_at and
    // resets approval, since the owner approved the previous numbers.
    if (body?.id) {
      const updated = await editExpenseRequest({
        organizationId: session.organizationId,
        id: body.id,
        title,
        description: description || null,
        descriptionOriginal,
        authorLanguage,
        category: body.category || "Other",
        estimatedAmount,
        currency: body.currency || "USD",
        vendor: body.vendor ?? null,
        urgency,
        neededBy: /^\d{4}-\d{2}-\d{2}$/.test(body.neededBy ?? "") ? body.neededBy! : null,
        referenceUrl: body.referenceUrl ?? null,
        byEmail: session.email,
        byName: me?.name ?? null,
      });
      if (!updated) {
        return NextResponse.json(
          { error: "That request no longer exists, or it's already completed and can't be edited." },
          { status: 404 }
        );
      }
      return NextResponse.json({ ok: true, request: updated, edited: true });
    }

    const request = await createExpenseRequest({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      title,
      description: description || null,
      descriptionOriginal,
      authorLanguage,
      category: body?.category || "Other",
      estimatedAmount,
      currency: body?.currency || "USD",
      vendor: body?.vendor ?? null,
      urgency,
      neededBy: /^\d{4}-\d{2}-\d{2}$/.test(body?.neededBy ?? "") ? body!.neededBy! : null,
      referenceUrl: body?.referenceUrl ?? null,
      requestedByEmail: session.email,
      requestedByName: me?.name ?? null,
    });
    return NextResponse.json({ ok: true, request });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const { session, me, error } = await context(req);
  if (error) return error;

  // Owner-only. This is the real gate for "only admin owner users can check
  // the approved box" — not the UI, which merely hides the checkbox.
  if (session.role !== "CEO") {
    return NextResponse.json(
      { error: "Only the owner can approve or decline an expense request." },
      { status: 403 }
    );
  }

  const body = (await req.json().catch(() => null)) as
    | { id?: string; approved?: boolean; declined?: boolean; declinedReason?: string }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const updated = await setApproval({
      organizationId: session.organizationId,
      id: body.id,
      approved: body.approved === true,
      declined: body.declined === true,
      declinedReason: body.declinedReason?.trim() || null,
      byEmail: session.email,
      byName: me?.name ?? null,
    });
    if (!updated) return NextResponse.json({ error: "No such request." }, { status: 404 });
    return NextResponse.json({ ok: true, request: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const { session, me, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | { id?: string; completed?: boolean; actualAmount?: string | number | null }
    | null;
  if (!body?.id || typeof body.completed !== "boolean") {
    return NextResponse.json({ error: "id and completed are required." }, { status: 400 });
  }

  const raw = body.actualAmount;
  const actualAmount = raw === "" || raw === null || raw === undefined ? null : Number(raw);
  // BUG FIX (2026-08-17 audit): this only checked Number.isFinite, while the
  // POST handler's estimatedAmount above correctly also requires >= 0. A
  // negative actual cost was accepted and stored, which then flows straight
  // into the spend rollups as a CREDIT — one mistyped "-450" quietly reduces
  // reported spend instead of increasing it. Same rule as the estimate.
  if (actualAmount !== null && (!Number.isFinite(actualAmount) || actualAmount < 0)) {
    return NextResponse.json({ error: "Actual cost must be a positive number." }, { status: 400 });
  }

  try {
    // BUG FIX (2026-08-17 audit): completion never checked approval. Anyone
    // could mark a DECLINED — or simply never-approved — request "completed"
    // with a real spend amount, and it would land in the completed list and
    // the spend totals as though the owner had signed off on it. That defeats
    // the whole point of the PATCH owner-only approval gate above: the money
    // is recorded as authorised without an authorisation ever happening.
    //
    // Only completion is gated. UN-ticking (completed === false) stays open so
    // a mis-click is always reversible, and a declined request stays visible
    // rather than becoming un-editable.
    if (body.completed) {
      // Deliberately UNfiltered by property group: listExpenseRequests caps at
      // the 300 most recent rows, and GET above reads the same list narrowed
      // to one group — so this superset always contains anything the user
      // could actually have seen and ticked, and can't 404 a legitimate
      // completion that the UI is showing.
      const existing = (await listExpenseRequests(session.organizationId)).find((r) => r.id === body.id);
      if (!existing) return NextResponse.json({ error: "No such request." }, { status: 404 });
      if (existing.declined) {
        return NextResponse.json(
          { error: "This request was declined by the owner, so it can't be marked as completed." },
          { status: 409 }
        );
      }
      if (!existing.approved) {
        return NextResponse.json(
          { error: "This request hasn't been approved yet. The owner needs to approve it before it can be marked as completed." },
          { status: 409 }
        );
      }
    }

    const updated = await setCompleted({
      organizationId: session.organizationId,
      id: body.id,
      completed: body.completed,
      actualAmount,
      byEmail: session.email,
      byName: me?.name ?? null,
    });
    if (!updated) return NextResponse.json({ error: "No such request." }, { status: 404 });
    return NextResponse.json({ ok: true, request: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { session, error } = await context(req);
  if (error) return error;
  if (session.role !== "CEO") {
    return NextResponse.json({ error: "Only the owner can delete a request." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const ok = await deleteExpenseRequest(session.organizationId, body.id);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "No such request." }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
