import { NextRequest, NextResponse } from "next/server";
import { createTeamActivity } from "@/lib/teamActivities";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { translateText } from "@/lib/translate";

export const dynamic = "force-dynamic";

// The ONE write endpoint a READ_ONLY (team) session may call — explicitly
// allowlisted in src/proxy.ts's role gate. Cleaners/property managers use
// it to log their own activities ("pool cleaned", "restocked towels") and
// to add per-stay ops notes (paid-extras requests, wedding/event flags).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { body?: string; bookingId?: number; kind?: string }
    | null;

  const text = body?.body?.trim();
  if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "Keep it under 2000 characters." }, { status: 400 });

  const kind = body?.kind === "note" ? "note" : "activity";
  const bookingId = typeof body?.bookingId === "number" && Number.isFinite(body.bookingId) ? body.bookingId : null;
  if (kind === "note" && bookingId === null) {
    return NextResponse.json({ error: "Notes must be attached to a stay." }, { status: 400 });
  }

  try {
    // Attribution (2026-08-16, Seni's ask: "show who added the note so
    // everyone can stay on the same page") — each team member now has their
    // own login with a display name on the user row; resolve it here so
    // entries read "Gabriel" instead of an email address.
    const user = await getUserByEmail(session.email).catch(() => null);

    // Language support (2026-08-16, Seni's ask): a team member set up in
    // Spanish/Portuguese writes in their own language; we store the English
    // translation as `body` (what an English-reading admin sees) plus the
    // original text, so nothing they wrote is ever lost. Translation failure
    // is non-fatal — we keep the original as the body rather than dropping
    // the note.
    const authorLanguage = user?.language || "English";
    let englishBody = text;
    let bodyOriginal: string | null = null;
    if (authorLanguage.toLowerCase() !== "english") {
      bodyOriginal = text;
      // NOTE: translateToLanguage() deliberately no-ops when the target is
      // English (it exists to translate INTO a guest's language), so this
      // uses translateText(..., "en") — the guest-message EN/ES helper —
      // which actually performs the into-English translation.
      try {
        const res = await translateText(text, "en", session.organizationId);
        if (res.ok && res.text.trim()) englishBody = res.text.trim();
      } catch (err) {
        console.error("[management/activities] translation to English failed:", err);
        englishBody = text;
      }
    }

    const activity = await createTeamActivity({
      organizationId: session.organizationId,
      bookingId,
      authorEmail: session.email,
      authorName: user?.name ?? null,
      kind,
      body: englishBody,
      bodyOriginal,
      authorLanguage,
    });
    return NextResponse.json({ ok: true, activity });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("POST /api/management/activities failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
