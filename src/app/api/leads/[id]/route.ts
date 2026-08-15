import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { updateLeadStage, updateLeadFields } from "@/lib/leads";
import { getSessionFromRequest } from "@/lib/session";
import type { LeadStage } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_STAGES: LeadStage[] = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "deposit",
  "booked",
  "lost",
  "nurture",
];

// Two independent kinds of edit, mirroring /api/bills/[id]'s pattern:
//   { stage: "...", lostReason?: "..." }   -> updateLeadStage (the pipeline-movement surface)
//   { fields: { guestName, ... } }         -> updateLeadFields (correcting contact info/notes)
// Send either or both in one request. Neither ever sends a guest-facing
// message or touches OwnerRez — see lib/leads.ts's header comment.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || (!body.stage && !body.fields)) {
    return NextResponse.json({ error: "Provide a stage and/or fields to update." }, { status: 400 });
  }

  if (body.stage && !VALID_STAGES.includes(body.stage)) {
    return NextResponse.json({ error: `stage must be one of: ${VALID_STAGES.join(", ")}` }, { status: 400 });
  }

  try {
    if (body.fields) {
      const fieldsResult = await updateLeadFields(id, body.fields, session?.organizationId);
      if (!fieldsResult) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
      if (!body.stage) return NextResponse.json({ lead: fieldsResult });
    }

    const lead = await updateLeadStage(
      id,
      { stage: body.stage, lostReason: body.lostReason },
      session?.organizationId
    );
    if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });
    return NextResponse.json({ lead });
  } catch (err) {
    return NextResponse.json(
      { error: `Lead update failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
