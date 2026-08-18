import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { translateText } from "@/lib/translate";
import { addTeamRequestNote, getTeamRequest } from "@/lib/teamRequests";

export const dynamic = "force-dynamic";

// Notes on a Team Request (2026-08-18, Seni's ask: "add a notes section
// where each team member can put in their notes back and forth" under
// Requests needing accept or deny — "make sure each note is time stamped
// identifying the team member that enters it"). Deliberately open to ANY
// logged-in team member, not just the requester/tagged person/CEO — same
// posture as the request lifecycle itself (see api/team-requests/route.ts's
// top comment: "anyone on the team," Seni's explicit choice) — this is a
// shared discussion thread, not a decision gate. Allowlisted for READ_ONLY
// sessions in src/proxy.ts alongside the rest of /api/team-requests.
//
//   POST {requestId, body} → any logged-in user in this org may add a note

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const me = await getUserByEmail(session.email).catch(() => null);

  const body = (await req.json().catch(() => null)) as { requestId?: string; body?: string } | null;
  const requestId = body?.requestId?.trim();
  if (!requestId) return NextResponse.json({ error: "requestId is required." }, { status: 400 });

  const typed = body?.body?.trim();
  if (!typed) return NextResponse.json({ error: "Say something before posting." }, { status: 400 });
  if (typed.length > 2000) return NextResponse.json({ error: "Keep notes under 2000 characters." }, { status: 400 });

  try {
    // Confirms the request is real and belongs to this org before writing a
    // note against it — the FK would catch a bogus id anyway, but this gives
    // a clean 404 instead of a raw constraint error.
    const existing = await getTeamRequest(requestId, session.organizationId);
    if (!existing) return NextResponse.json({ error: "No such request." }, { status: 404 });

    // Same language handling as the request's own description: a
    // Spanish/Portuguese teammate writes in their own language, everyone
    // else reads the English translation, and the original is kept so
    // nothing they wrote is lost.
    const authorLanguage = me?.language || "English";
    let noteBody = typed;
    let bodyOriginal: string | null = null;
    if (authorLanguage.toLowerCase() !== "english") {
      bodyOriginal = typed;
      try {
        const res = await translateText(typed, "en", session.organizationId);
        if (res.ok && res.text.trim()) noteBody = res.text.trim();
      } catch (err) {
        console.error("[team-requests/notes] translation to English failed:", err);
        noteBody = typed;
      }
    }

    const note = await addTeamRequestNote({
      organizationId: session.organizationId,
      requestId,
      authorEmail: session.email,
      authorName: me?.name ?? null,
      body: noteBody,
      bodyOriginal,
      authorLanguage,
    });

    return NextResponse.json({ ok: true, note });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
