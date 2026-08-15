import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { decideReputationResponse } from "@/lib/reputationManager";
import { getSessionFromRequest } from "@/lib/session";
import type { ReputationResponseStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_STATUSES: ReputationResponseStatus[] = ["pending_review", "approved", "rejected", "posted"];

// { status: "approved", draftText?: "..." } — draftText lets Seni edit the
// copy as part of approving it. { status: "rejected" } — no response will
// ever be posted. { status: "posted" } — Seni confirming he already copied
// the approved text into OwnerRez's own Quality Center himself. This route
// NEVER posts anything anywhere itself — see lib/reputationManager.ts's
// header comment for why that's a hard API constraint, not just a v1 choice.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const response = await decideReputationResponse(
      id,
      {
        status: body.status,
        draftText: typeof body.draftText === "string" ? body.draftText : undefined,
      },
      session?.organizationId
    );
    if (!response) return NextResponse.json({ error: "Response not found." }, { status: 404 });
    return NextResponse.json({ response });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 }
    );
  }
}
