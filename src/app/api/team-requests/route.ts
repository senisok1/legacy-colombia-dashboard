import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail, listUsers } from "@/lib/users";
import { translateText } from "@/lib/translate";
import { createTeamActivity } from "@/lib/teamActivities";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import {
  createTeamRequest,
  deleteTeamRequest,
  listTeamRequests,
  setCompleted,
  setDecision,
} from "@/lib/teamRequests";
import { notifyRequesterOfDecision, notifyTaggedPersonOfNewRequest, type NotifyPerson } from "@/lib/teamRequestNotify";

export const dynamic = "force-dynamic";

// Team Requests (2026-08-18, Seni's ask: an item under the Team Activity Log
// tab like "tour guide requested Aug 25th, please accept or deny", tagged to
// one teammate, notified by WhatsApp/email). Lifecycle mirrors Team Expense
// Requests (api/team-expenses/route.ts), with one deliberate difference:
// approval there is CEO-only, but here it's whoever was TAGGED — any team
// member can raise a request and tag any other login, per Seni's explicit
// choice ("anyone on the team" — recommended over owner-only).
//
//   GET                                    → every request for this property, plus the
//                                             taggable-teammates list for the dropdown
//   POST   {title, taggedEmail, …}         → any logged-in user may request
//   PATCH  {id, accepted|declined}         → ONLY the tagged person (or a CEO override)
//   PUT    {id, completed}                 → requester, tagged person, or a CEO
//   DELETE {id}                            → the requester or a CEO
//
// POST/PATCH/PUT are allowlisted for READ_ONLY sessions in src/proxy.ts —
// same reasoning as Team Expense Requests: the on-site team raises and
// resolves these themselves, without needing an admin in the loop for
// day-to-day coordination.

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

function loginUrlFor(req: NextRequest): string {
  return req.nextUrl.origin.includes("localhost")
    ? "https://crm.legacyestaterentals.com/team-log"
    : `${req.nextUrl.origin}/team-log`;
}

function toNotifyPerson(u: { email: string; name: string | null; whatsappPhone: string | null; language: string }): NotifyPerson {
  return { email: u.email, name: u.name, phone: u.whatsappPhone, language: u.language || "English" };
}

export async function GET(req: NextRequest) {
  const { session, me, groupId, error } = await context(req);
  if (error) return error;
  try {
    const [requests, allUsers] = await Promise.all([
      listTeamRequests(session.organizationId, groupId),
      listUsers(session.organizationId),
    ]);
    return NextResponse.json({
      requests,
      // Any active login is taggable — not just CEOs — since a team member
      // can tag another team member (e.g. Gabriel asking Ahmed).
      teamMembers: allUsers
        .filter((u) => u.active)
        .map((u) => ({ email: u.email, name: u.name, isYou: u.email.toLowerCase() === session.email.toLowerCase() })),
      viewerEmail: session.email,
      viewerIsCeo: session.role === "CEO",
      viewerLanguage: me?.language || "English",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { session, me, groupId, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | { title?: string; description?: string; neededBy?: string; taggedEmail?: string }
    | null;

  const title = body?.title?.trim();
  if (!title) return NextResponse.json({ error: "Say what you need." }, { status: 400 });
  if (title.length > 200) return NextResponse.json({ error: "Keep the title under 200 characters." }, { status: 400 });

  const taggedEmail = body?.taggedEmail?.trim().toLowerCase();
  if (!taggedEmail) return NextResponse.json({ error: "Choose who should accept or deny this." }, { status: 400 });

  try {
    // The tagged person must be a real, active login in THIS org — otherwise
    // a forged email in the request body could create a request nobody will
    // ever see or be notified about.
    const orgUsers = await listUsers(session.organizationId);
    const tagged = orgUsers.find((u) => u.email.toLowerCase() === taggedEmail && u.active);
    if (!tagged) {
      return NextResponse.json({ error: "That person isn't an active team login." }, { status: 400 });
    }

    // Same language handling as Management notes / Team Expense Requests: a
    // Spanish/Portuguese teammate writes in their own language, the request
    // stores the English translation for anyone reading it, and the
    // original text is kept so nothing they wrote is lost.
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
        console.error("[team-requests] translation to English failed:", err);
        description = typed;
      }
    }

    const neededBy = /^\d{4}-\d{2}-\d{2}$/.test(body?.neededBy ?? "") ? body!.neededBy! : null;

    const request = await createTeamRequest({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      title,
      description: description || null,
      descriptionOriginal,
      authorLanguage,
      neededBy,
      requestedByEmail: session.email,
      requestedByName: me?.name ?? null,
      taggedEmail: tagged.email,
      taggedName: tagged.name,
    });

    // Best-effort — a notification failure must never fail the request
    // itself; the request already exists and is visible on the dashboard
    // either way. Result is returned so the UI can say "couldn't reach them
    // — let them know directly" rather than silently claiming success.
    const notifyResult = await notifyTaggedPersonOfNewRequest(
      request,
      toNotifyPerson(tagged),
      loginUrlFor(req),
      session.organizationId
    ).catch((err) => ({
      whatsappSent: false,
      whatsappError: err instanceof Error ? err.message : "Unknown error.",
      emailSent: false,
      emailError: err instanceof Error ? err.message : "Unknown error.",
    }));

    await createTeamActivity({
      organizationId: session.organizationId,
      propertyGroupId: groupId,
      authorEmail: session.email,
      authorName: me?.name ?? null,
      kind: "activity",
      body: `Requested: "${title}" — tagged ${tagged.name || tagged.email} to accept or deny.`,
    }).catch(() => {});

    return NextResponse.json({ ok: true, request, notify: notifyResult });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const { session, me, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as
    | { id?: string; accepted?: boolean; declined?: boolean; declineReason?: string }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const [requests, orgUsers] = await Promise.all([
      listTeamRequests(session.organizationId),
      listUsers(session.organizationId),
    ]);
    const existing = requests.find((r) => r.id === body.id);
    if (!existing) return NextResponse.json({ error: "No such request." }, { status: 404 });

    // Only the tagged person may decide — or a CEO, as an override for when
    // someone's out sick / no longer has access. This is the real gate; the
    // UI only hides the buttons for everyone else.
    const isTagged = existing.taggedEmail.toLowerCase() === session.email.toLowerCase();
    if (!isTagged && session.role !== "CEO") {
      return NextResponse.json(
        { error: `Only ${existing.taggedName || existing.taggedEmail} can accept or deny this.` },
        { status: 403 }
      );
    }
    if (existing.accepted || existing.declined) {
      return NextResponse.json({ error: "This request was already decided." }, { status: 409 });
    }

    const updated = await setDecision({
      organizationId: session.organizationId,
      id: body.id,
      accepted: body.accepted === true,
      declined: body.declined === true,
      declineReason: body.declineReason?.trim() || null,
      byEmail: session.email,
      byName: me?.name ?? null,
    });
    if (!updated) return NextResponse.json({ error: "No such request." }, { status: 404 });

    const requester = orgUsers.find((u) => u.email.toLowerCase() === updated.requestedByEmail.toLowerCase());
    const notifyResult = requester
      ? await notifyRequesterOfDecision(
          updated,
          toNotifyPerson(requester),
          loginUrlFor(req),
          session.organizationId
        ).catch(() => ({ whatsappSent: false, emailSent: false }))
      : { whatsappSent: false, emailSent: false };

    await createTeamActivity({
      organizationId: session.organizationId,
      propertyGroupId: updated.propertyGroupId,
      authorEmail: session.email,
      authorName: me?.name ?? null,
      kind: "activity",
      body: updated.accepted
        ? `Accepted: "${updated.title}" (requested by ${updated.requestedByName || updated.requestedByEmail}).`
        : `Declined: "${updated.title}" (requested by ${updated.requestedByName || updated.requestedByEmail}).${
            updated.declineReason ? ` Reason: ${updated.declineReason}` : ""
          }`,
    }).catch(() => {});

    return NextResponse.json({ ok: true, request: updated, notify: notifyResult });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const { session, me, error } = await context(req);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { id?: string; completed?: boolean } | null;
  if (!body?.id || typeof body.completed !== "boolean") {
    return NextResponse.json({ error: "id and completed are required." }, { status: 400 });
  }

  try {
    if (body.completed) {
      const existing = (await listTeamRequests(session.organizationId)).find((r) => r.id === body.id);
      if (!existing) return NextResponse.json({ error: "No such request." }, { status: 404 });
      if (existing.declined) {
        return NextResponse.json(
          { error: "This request was declined, so it can't be marked as completed." },
          { status: 409 }
        );
      }
      if (!existing.accepted) {
        return NextResponse.json(
          { error: "This request hasn't been accepted yet." },
          { status: 409 }
        );
      }
    }

    const updated = await setCompleted({
      organizationId: session.organizationId,
      id: body.id,
      completed: body.completed,
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

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  try {
    const existing = (await listTeamRequests(session.organizationId)).find((r) => r.id === body.id);
    if (!existing) return NextResponse.json({ error: "No such request." }, { status: 404 });
    if (existing.requestedByEmail.toLowerCase() !== session.email.toLowerCase() && session.role !== "CEO") {
      return NextResponse.json({ error: "Only the requester or an admin can delete this." }, { status: 403 });
    }

    const ok = await deleteTeamRequest(session.organizationId, body.id);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "No such request." }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error." }, { status: 500 });
  }
}
