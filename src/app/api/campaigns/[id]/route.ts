import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { approveCandidate, skipCandidate } from "@/lib/lifecycleMarketing";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// { action: "approve" } sends the drafted message via OwnerRez's thread API
// (see lib/lifecycleMarketing.ts's approveCandidate — this is the ONLY path
// that ever actually messages a guest). { action: "skip" } just dismisses
// the candidate with no send. There is deliberately no bulk-approve — every
// send is a distinct, individually-reviewed decision.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || (body.action !== "approve" && body.action !== "skip")) {
    return NextResponse.json({ error: "action must be 'approve' or 'skip'." }, { status: 400 });
  }

  try {
    const candidate =
      body.action === "approve"
        ? await approveCandidate(id, session?.organizationId)
        : await skipCandidate(id, session?.organizationId);
    if (!candidate) return NextResponse.json({ error: "Candidate not found." }, { status: 404 });
    return NextResponse.json({ candidate });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 }
    );
  }
}
