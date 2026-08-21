import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { translateReviewComments } from "@/lib/translate";

export const dynamic = "force-dynamic";

// Reputation tab (2026-08-21, Seni: "I need to see all of that in english as
// well so I can understand it") — translates guest review text the same way
// ThreadInbox already translates guest messages. No extra access gate beyond
// a session, matching GET /api/reputation's own posture (read-only, org-scoped).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const body = (await req.json().catch(() => null)) as { reviews?: { id?: number; comment?: string }[] } | null;
  const reviews = (body?.reviews ?? [])
    .filter((r): r is { id: number; comment: string } => typeof r?.id === "number" && typeof r?.comment === "string")
    .slice(0, 200); // sane upper bound — a single batch call already covers a full page of reviews

  try {
    const translations = await translateReviewComments(reviews, session?.organizationId);
    return NextResponse.json({ translations });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/reputation/translate failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
