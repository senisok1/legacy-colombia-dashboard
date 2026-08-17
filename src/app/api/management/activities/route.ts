import { NextRequest, NextResponse } from "next/server";
import { createTeamActivity } from "@/lib/teamActivities";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { translateText } from "@/lib/translate";
import { getBookings } from "@/lib/ownerrez";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

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

    // Property scoping + bookingId authorisation (2026-08-17 audit).
    //
    // THE BUG: this route accepted ANY numeric bookingId from the request body
    // and wrote a note against it, with no check that the booking belongs to
    // the caller's property. OwnerRez booking ids are small sequential
    // integers, so a team member limited to Legacy Colombia could attach notes
    // to another property's stays just by changing a number in the payload —
    // and those notes then render on that property's Management board next to
    // the guest's name and contact details.
    //
    // Group resolution matches src/app/api/management/route.ts exactly:
    // effectivePropertyGroupId() re-checks the cookie against the user's OWN
    // propertyAccess, so a forged cookie can't widen access either. getBookings
    // is already group-scoped and cached (unstable_cache, 60s), so this costs
    // nothing on the hot path.
    const groupId = effectivePropertyGroupId(
      req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
      user?.propertyAccess
    );
    if (bookingId !== null) {
      // Fail CLOSED: if the booking list can't be loaded we cannot prove the
      // stay is this property's, and the whole point of the check is that an
      // unverified id must not be written.
      const bookings = await getBookings(session.organizationId, groupId).catch(() => null);
      if (!bookings) {
        return NextResponse.json(
          { error: "Couldn't verify which stay this belongs to just now. Please try again in a moment." },
          { status: 503 }
        );
      }
      if (!bookings.some((b) => b.id === bookingId)) {
        return NextResponse.json(
          { error: "That stay isn't part of the property you're viewing." },
          { status: 403 }
        );
      }
    }

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
      // Stamps the row's property (migration 0035) so the general activity
      // log stops being shared across all five properties — see
      // src/lib/teamActivities.ts's listTeamActivities.
      propertyGroupId: groupId,
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
