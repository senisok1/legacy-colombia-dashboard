import { NextRequest, NextResponse } from "next/server";
import { sendMessage } from "@/lib/ownerrez";
import { appendMessage } from "@/lib/store";
import { resolvePendingDraft, claimDraftForSend, releaseDraftClaim } from "@/lib/pendingDrafts";
import { sendWhatsAppText } from "@/lib/whatsapp";
import { translateToLanguage } from "@/lib/translate";
import { isMessagingConfigured, isWhatsAppConfigured } from "@/lib/config";
import { notifyGabrielIfServiceRequest } from "@/lib/serviceRequestNotify";
import { logAiActivity } from "@/lib/aiActivity";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

const AGENT_KEY = "guest_experience";
const AGENT_NAME = "AI Guest Experience Manager";

type ReplyBody = {
  threadId: number;
  bookingId: number;
  guestId: number | null;
  guestName?: string;
  body?: string; // English text Seni composed/edited — required unless action is "discard"
  draftId?: string; // set when this reply resolves a pending AI draft (approve or edit)
  action: "approve" | "edit" | "discard";
  // Human-readable language name (e.g. "Spanish") to translate `body` into
  // before it's sent — only meaningful for "edit" (Seni typed English;
  // "approve" already sends the AI draft's native-language text as-is).
  targetLanguage?: string;
};

// Handles every way Seni can act on a conversation from the dashboard
// Inbox: approving the AI suggestion as-is, sending an edited/custom reply,
// or discarding a suggestion outright. Shares the same pendingDrafts store
// as the WhatsApp approval flow (see api/whatsapp/webhook/route.ts) so
// resolving a draft here also clears it there — approving in the dashboard
// while a WhatsApp approval request for the same draft is still sitting
// unread won't cause a double-send, and Seni gets a heads-up on WhatsApp
// either way so the two channels never look out of sync.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!isMessagingConfigured()) {
    return NextResponse.json(
      { error: "OwnerRez messaging isn't connected yet. Visit /api/oauth/start once to connect it." },
      { status: 400 }
    );
  }

  const payload = (await req.json().catch(() => null)) as ReplyBody | null;
  if (!payload || !payload.action) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Guest response time is recorded per property (2026-08-17 audit): the
  // write used an un-namespaced Redis key while the read was namespaced, so
  // Colombia's metric was contaminated by every property and the other four
  // read a permanently empty key. resolvePendingDraft threads this through
  // to recordResponseTime.
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    viewer?.propertyAccess
  );

  if (payload.action === "discard") {
    if (payload.draftId) {
      await resolvePendingDraft(payload.draftId, { status: "rejected" }, session?.organizationId, groupId);
      if (isWhatsAppConfigured()) {
        await sendWhatsAppText(
          `Discarded that suggested reply to ${payload.guestName ?? "the guest"} from the dashboard.`,
          session?.organizationId
        ).catch(() => {});
      }
      await logAiActivity({
        agentKey: AGENT_KEY,
        agentDisplayName: AGENT_NAME,
        task: "Resolve guest reply approval",
        trigger: `Seni discarded draft ${payload.draftId} from the dashboard`,
        decision: "rejected",
        actionTaken: "Discarded suggested reply — nothing sent to guest",
        result: "rejected",
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (!payload.threadId) {
    return NextResponse.json({ error: "threadId is required." }, { status: 400 });
  }

  // SECURITY FIX (2026-08-17 audit). This path used to send payload.body — the
  // BROWSER's text — for BOTH approve and edit, and only marked the draft
  // resolved afterward, with no read of its status. Two consequences:
  //   1. Approving here after (or during) a WhatsApp "yes" sent the guest the
  //      message TWICE — the exact double-send the old comment claimed was
  //      impossible.
  //   2. "approve" sent whatever the client POSTed, not the reviewed draft.
  //
  // Now: on "approve" the STORED draft text is authoritative (the client body
  // is ignored), and every draft-backed send goes through the same atomic
  // claim the WhatsApp path uses, so a draft is sent at most once across both
  // channels.
  const draftId = payload.draftId;

  // What actually goes to the guest, and what's logged in English.
  let sendText: string;
  let englishBody: string;

  if (draftId) {
    // Claim first — this both proves the draft is still pending AND blocks a
    // racing WhatsApp/dashboard approval of the same draft.
    const claim = await claimDraftForSend(draftId, session?.organizationId);
    if (!claim.ok) {
      const why =
        claim.reason === "in_flight"
          ? "is already being sent from another channel"
          : claim.reason === "already_resolved"
            ? `was already ${claim.draft?.status ?? "resolved"}`
            : "no longer exists";
      return NextResponse.json(
        { error: `That reply ${why} — nothing was sent. Refresh the Approvals tab.` },
        { status: 409 }
      );
    }
    const draft = claim.draft;

    if (payload.action === "approve") {
      // Authoritative: the reviewed draft, already in the guest's language.
      sendText = draft.draftReply ?? "";
      englishBody = draft.replyEnglish ?? draft.draftReply ?? "";
    } else {
      // Edit of a suggestion: Seni's own English text, translated out.
      englishBody = payload.body?.trim() ?? "";
      if (!englishBody) {
        await releaseDraftClaim(draftId, session?.organizationId);
        return NextResponse.json({ error: "Your edited reply is empty." }, { status: 400 });
      }
      sendText = payload.targetLanguage
        ? await translateToLanguage(englishBody, payload.targetLanguage, session?.organizationId)
        : englishBody;
    }

    if (!sendText.trim()) {
      await releaseDraftClaim(draftId, session?.organizationId);
      return NextResponse.json({ error: "That draft is empty — nothing was sent." }, { status: 400 });
    }

    try {
      await sendMessage(payload.threadId, sendText, session?.organizationId);
    } catch (err) {
      // Send genuinely failed → release the claim so a real retry can proceed.
      await releaseDraftClaim(draftId, session?.organizationId);
      await resolvePendingDraft(draftId, { status: "failed" }, session?.organizationId, groupId);
      const message = err instanceof Error ? err.message : "Failed to send message.";
      const failedEntry = await appendMessage({
        bookingId: payload.bookingId,
        guestId: payload.guestId,
        guestName: payload.guestName,
        subject: "AI-assisted reply (dashboard)",
        language: "en",
        body: englishBody,
        status: "failed",
      }, session?.organizationId).catch(() => null);
      return NextResponse.json({ error: message, entry: failedEntry }, { status: 502 });
    }

    // Sent. Nothing below can un-send it, so keep it "sent" regardless.
    const entry = await appendMessage({
      bookingId: payload.bookingId,
      guestId: payload.guestId,
      guestName: payload.guestName,
      subject:
        payload.action === "approve"
          ? "AI-assisted reply (dashboard-approved)"
          : "AI-assisted reply, edited (dashboard)",
      language: "en",
      body: englishBody,
      status: "sent",
    }, session?.organizationId).catch(() => null);

    const resolved = await resolvePendingDraft(
      draftId,
      { status: "sent", draftReply: sendText },
      session?.organizationId,
      groupId
    ).catch(() => null);
    if (isWhatsAppConfigured()) {
      const gabrielNote = resolved ? await notifyGabrielIfServiceRequest(resolved, groupId).catch(() => "") : "";
      await sendWhatsAppText(
        `Sent to ${payload.guestName ?? "the guest"} via dashboard ✅${gabrielNote}`,
        session?.organizationId
      ).catch(() => {});
    }
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Send guest reply",
      trigger: `Seni resolved draft ${draftId} from the dashboard (${payload.action})`,
      decision: payload.action === "approve" ? "approved as drafted" : "approved with edits",
      communicationSent: { channel: "ownerrez_message", threadId: payload.threadId, body: sendText },
      actionTaken: "Sent message to guest via OwnerRez",
      result: "sent",
    }).catch(() => {});

    return NextResponse.json({ ok: true, entry });
  }

  // No draftId: a direct/free-typed reply, not tied to any AI draft. No claim
  // to contend for — but still translate out and isolate the send.
  englishBody = payload.body?.trim() ?? "";
  if (!englishBody) {
    return NextResponse.json({ error: "body is required." }, { status: 400 });
  }
  sendText = payload.targetLanguage
    ? await translateToLanguage(englishBody, payload.targetLanguage, session?.organizationId)
    : englishBody;

  try {
    await sendMessage(payload.threadId, sendText, session?.organizationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send message.";
    const failedEntry = await appendMessage({
      bookingId: payload.bookingId,
      guestId: payload.guestId,
      guestName: payload.guestName,
      subject: "Direct reply (dashboard)",
      language: "en",
      body: englishBody,
      status: "failed",
    }, session?.organizationId).catch(() => null);
    return NextResponse.json({ error: message, entry: failedEntry }, { status: 502 });
  }

  const entry = await appendMessage({
    bookingId: payload.bookingId,
    guestId: payload.guestId,
    guestName: payload.guestName,
    subject: "Direct reply (dashboard)",
    language: "en",
    body: englishBody,
    status: "sent",
  }, session?.organizationId).catch(() => null);

  return NextResponse.json({ ok: true, entry });
}
