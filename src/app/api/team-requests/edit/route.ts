import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail, listUsers } from "@/lib/users";
import { translateText } from "@/lib/translate";
import { createTeamActivity } from "@/lib/teamActivities";
import { getTeamRequest, updateTeamRequest } from "@/lib/teamRequests";
import { notifyTaggedPersonOfNewRequest, type NotifyPerson } from "@/lib/teamRequestNotify";

export const dynamic = "force-dynamic";

// Editing a Team Request's own details (2026-08-18, Seni's ask: "add an edit
// tab next to the remove tab so the original person that creates the
// request can edit. Only that person should be able to edit that request.").
// Deliberately its own route rather than overloading the main
// api/team-requests PATCH (that one is reserved for the tagged person's
// accept/deny decision — a different action by a different person).
//
//   PATCH {id, title, description, neededBy, taggedEmail} → ONLY the
//     original requester, no CEO override. Blocked once a decision has been
//     made (accepted/declined) so nobody can quietly change what someone
//     already accepted or declined — same state-gating convention as the
//     rest of this feature (see setDecision/setCompleted's own guards).
//
// Allowlisted for READ_ONLY sessions in src/proxy.ts, same as the rest of
// /api/team-requests — a team member editing their own request is exactly
// the on-site, no-admin-needed workflow this feature exists for.

function loginUrlFor(req: NextRequest): string {
  return req.nextUrl.origin.includes("localhost")
    ? "https://crm.legacyestaterentals.com/team-log"
    : `${req.nextUrl.origin}/team-log`;
}

function toNotifyPerson(u: { email: string; name: string | null; whatsappPhone: string | null; language: string }): NotifyPerson {
  return { email: u.email, name: u.name, phone: u.whatsappPhone, language: u.language || "English" };
}

export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  const me = await getUserByEmail(session.email).catch(() => null);

  const body = (await req.json().catch(() => null)) as
    | { id?: string; title?: string; description?: string; neededBy?: string; taggedEmail?: string }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "Say what you need." }, { status: 400 });
  if (title.length > 200) return NextResponse.json({ error: "Keep the title under 200 characters." }, { status: 400 });

  const taggedEmail = body.taggedEmail?.trim().toLowerCase();
  if (!taggedEmail) return NextResponse.json({ error: "Choose who should accept or deny this." }, { status: 400 });

  try {
    const existing = await getTeamRequest(body.id, session.organizationId);
    if (!existing) return NextResponse.json({ error: "No such request." }, { status: 404 });

    // Only the original requester may edit — no CEO override (2026-08-18,
    // Seni: "only that person should be able to edit that request").
    if (existing.requestedByEmail.toLowerCase() !== session.email.toLowerCase()) {
      return NextResponse.json(
        { error: `Only ${existing.requestedByName || existing.requestedByEmail} can edit this.` },
        { status: 403 }
      );
    }
    if (existing.accepted || existing.declined) {
      return NextResponse.json(
        { error: "This request was already decided, so it can no longer be edited." },
        { status: 409 }
      );
    }

    const orgUsers = await listUsers(session.organizationId);
    const tagged = orgUsers.find((u) => u.email.toLowerCase() === taggedEmail && u.active);
    if (!tagged) {
      return NextResponse.json({ error: "That person isn't an active team login." }, { status: 400 });
    }

    // Same language handling as create: a Spanish/Portuguese teammate writes
    // in their own language, everyone else reads the English translation.
    const authorLanguage = me?.language || "English";
    const typed = body.description?.trim() || "";
    let description = typed;
    let descriptionOriginal: string | null = null;
    if (typed && authorLanguage.toLowerCase() !== "english") {
      descriptionOriginal = typed;
      try {
        const res = await translateText(typed, "en", session.organizationId);
        if (res.ok && res.text.trim()) description = res.text.trim();
      } catch (err) {
        console.error("[team-requests/edit] translation to English failed:", err);
        description = typed;
      }
    }

    const neededBy = /^\d{4}-\d{2}-\d{2}$/.test(body.neededBy ?? "") ? body.neededBy! : null;
    const retagged = existing.taggedEmail.toLowerCase() !== tagged.email.toLowerCase();

    const updated = await updateTeamRequest({
      organizationId: session.organizationId,
      id: body.id,
      title,
      description: description || null,
      descriptionOriginal,
      authorLanguage,
      neededBy,
      taggedEmail: tagged.email,
      taggedName: tagged.name,
    });
    if (!updated) return NextResponse.json({ error: "No such request." }, { status: 404 });

    // Only re-notify when the tagged person actually changed — the new
    // person has no idea this request exists yet. If the same person is
    // still tagged, an edit doesn't re-send (avoids spamming them for
    // typo fixes); they'll see the updated text next time they open the tab.
    const notifyResult = retagged
      ? await notifyTaggedPersonOfNewRequest(
          updated,
          toNotifyPerson(tagged),
          loginUrlFor(req),
          session.organizationId
        ).catch((err) => ({
          whatsappSent: false,
          whatsappError: err instanceof Error ? err.message : "Unknown error.",
          emailSent: false,
          emailError: err instanceof Error ? err.message : "Unknown error.",
        }))
      : undefined;

    await createTeamActivity({
      organizationId: session.organizationId,
      propertyGroupId: updated.propertyGroupId,
      authorEmail: session.email,
      authorName: me?.name ?? null,
      kind: "activity",
      body: retagged
        ? `Edited request "${updated.title}" and re-tagged ${tagged.name || tagged.email} to accept or deny.`
        : `Edited request "${updated.title}".`,
    }).catch(() => {});

    return NextResponse.json({ ok: true, request: updated, notify: notifyResult });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
