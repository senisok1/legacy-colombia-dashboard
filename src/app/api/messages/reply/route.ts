import { NextRequest, NextResponse } from "next/server";
import { sendMessage } from "@/lib/ownerrez";
import { appendMessage } from "@/lib/store";
import { resolvePendingDraft } from "@/lib/pendingDrafts";
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

  if (!payload.threadId || !payload.body?.trim()) {
    return NextResponse.json({ error: "threadId and body are required." }, { status: 400 });
  }

  // Seni only writes in English. "approve" sends the AI draft's reply,
  // which is already in the guest's own language — nothing to translate.
  // "edit" (his own free-typed or edited-from-suggestion text) gets
  // auto-translated into the guest's language before it goes out, the same
  // rule the WhatsApp approval flow uses (see api/whatsapp/webhook).
  const englishBody = payload.body;
  const sendText =
    payload.action === "edit" && payload.targetLanguage
      ? await translateToLanguage(englishBody, payload.targetLanguage, session?.organizationId)
      : englishBody;

  try {
    await sendMessage(payload.threadId, sendText, session?.organizationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send message.";
    if (payload.draftId) await resolvePendingDraft(payload.draftId, { status: "failed" }, session?.organizationId, groupId);
    const failedEntry = await appendMessage({
      bookingId: payload.bookingId,
      guestId: payload.guestId,
      guestName: payload.guestName,
      subject: payload.action === "approve" ? "AI-assisted reply (dashboard)" : "Direct reply (dashboard)",
      language: "en",
      body: englishBody,
      status: "failed",
    }, session?.organizationId);
    if (payload.draftId) {
      await logAiActivity({
        agentKey: AGENT_KEY,
        agentDisplayName: AGENT_NAME,
        task: "Send guest reply",
        trigger: `Draft ${payload.draftId} (dashboard)`,
        error: message,
        result: "failed",
      });
    }
    return NextResponse.json({ error: message, entry: failedEntry }, { status: 502 });
  }

  // Logged in English (what Seni actually wrote) so his own Sent log stays
  // readable — the guest received sendText, in their own language.
  const entry = await appendMessage({
    bookingId: payload.bookingId,
    guestId: payload.guestId,
    guestName: payload.guestName,
    subject:
      payload.action === "approve"
        ? "AI-assisted reply (dashboard-approved)"
        : payload.draftId
          ? "AI-assisted reply, edited (dashboard)"
          : "Direct reply (dashboard)",
    language: "en",
    body: englishBody,
    status: "sent",
  }, session?.organizationId);

  if (payload.draftId) {
    const resolved = await resolvePendingDraft(
      payload.draftId,
      { status: "sent", draftReply: sendText },
      session?.organizationId,
      groupId
    );
    if (isWhatsAppConfigured()) {
      const gabrielNote = resolved ? await notifyGabrielIfServiceRequest(resolved) : "";
      await sendWhatsAppText(
        `Sent to ${payload.guestName ?? "the guest"} via dashboard ✅${gabrielNote}`,
        session?.organizationId
      ).catch(() => {});
    }
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Send guest reply",
      trigger: `Seni resolved draft ${payload.draftId} from the dashboard (${payload.action})`,
      decision: payload.action === "approve" ? "approved as drafted" : "approved with edits",
      communicationSent: { channel: "ownerrez_message", threadId: payload.threadId, body: sendText },
      actionTaken: "Sent message to guest via OwnerRez",
      result: "sent",
    });
  }

  return NextResponse.json({ ok: true, entry });
}
