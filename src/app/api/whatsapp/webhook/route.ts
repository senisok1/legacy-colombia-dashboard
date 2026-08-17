import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import {
  parseIncomingWhatsAppMessages,
  isFromAuthorizedSender,
  isFromGabriel,
  sendWhatsAppText,
  sendWhatsAppTextTo,
  sendGuestReplyApprovalTemplate,
  type IncomingWhatsAppMessage,
} from "@/lib/whatsapp";
import {
  getPendingDraftByWamid,
  getOldestPendingDraft,
  resolvePendingDraft,
} from "@/lib/pendingDrafts";
import {
  getChatEscalationByWamid,
  getOldestPendingChatEscalation,
  getPendingWhatsAppEscalationByPhone,
  createChatEscalation,
  linkChatEscalationWamid,
  resolveChatEscalation,
} from "@/lib/chatEscalations";
import { draftEscalationAnswerForApproval } from "@/lib/chatWidget";
import { sendMessage } from "@/lib/ownerrez";
import { appendMessage } from "@/lib/store";
import { translateToLanguage } from "@/lib/translate";
import { notifyGabrielIfServiceRequest } from "@/lib/serviceRequestNotify";
import { logAiActivity } from "@/lib/aiActivity";
import { handleBillForward } from "@/lib/billForward";
import type { PendingDraft, ChatEscalation } from "@/lib/types";

// Downloading a WhatsApp media file + running Claude vision extraction
// (see lib/billForward.ts) can take longer than the platform's default 10s
// function timeout, especially alongside the existing translate/OwnerRez-send
// work this route already does for guest-reply approvals.
export const maxDuration = 30;

const AGENT_KEY = "guest_experience";
const AGENT_NAME = "AI Guest Experience Manager";
const CHAT_AGENT_KEY = "chat_widget";
const CHAT_AGENT_NAME = "AI Website Chat Widget";
const WA_INQUIRY_AGENT_KEY = "whatsapp_inquiry";
const WA_INQUIRY_AGENT_NAME = "AI WhatsApp Inquiry Handler";

// Meta's one-time webhook verification handshake. When you subscribe this
// URL in Meta for Developers, it GETs this endpoint with a challenge and
// expects it echoed back verbatim, but only if the verify token matches.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === config.whatsappVerifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "Verification failed." }, { status: 403 });
}

// This webhook now disambiguates an incoming WhatsApp reply against TWO
// independent kinds of pending approval that share the same YES/NO/EDIT:
// protocol and the same WhatsApp number:
//   - guest-reply drafts (lib/pendingDrafts.ts) — replying to an OwnerRez
//     guest message thread.
//   - website chat-widget escalations (lib/chatEscalations.ts) — answering
//     an anonymous visitor's question the widget couldn't confidently
//     answer on its own (see lib/chatWidget.ts).
// Swiping to reply on a specific approval message (WhatsApp's normal
// "reply" gesture) targets that exact item by wamid, whichever kind it is.
// A plain reply with no context falls back to whichever of the two is
// oldest overall — fine for a single-property, low-volume inbox where it's
// rare to have more than one open approval at once across both kinds.
type PendingApproval =
  | { kind: "draft"; draft: PendingDraft }
  | { kind: "escalation"; escalation: ChatEscalation };

async function resolvePendingApproval(contextWamid: string | undefined): Promise<PendingApproval | null> {
  if (contextWamid) {
    const draft = await getPendingDraftByWamid(contextWamid);
    if (draft) return { kind: "draft", draft };
    const escalation = await getChatEscalationByWamid(contextWamid);
    if (escalation) return { kind: "escalation", escalation };
    // Fall through to the "oldest overall" fallback below — a swipe-reply
    // to a message that isn't a tracked approval (e.g. an old confirmation
    // text) shouldn't silently do nothing if there's still something
    // genuinely pending.
  }

  const [oldestDraft, oldestEscalation] = await Promise.all([
    getOldestPendingDraft(),
    getOldestPendingChatEscalation(),
  ]);
  if (oldestDraft && oldestEscalation) {
    return oldestDraft.createdAt <= oldestEscalation.createdAt
      ? { kind: "draft", draft: oldestDraft }
      : { kind: "escalation", escalation: oldestEscalation };
  }
  if (oldestDraft) return { kind: "draft", draft: oldestDraft };
  if (oldestEscalation) return { kind: "escalation", escalation: oldestEscalation };
  return null;
}

/**
 * Handles a text message from someone who is NOT Seni or Gabriel — i.e. a
 * genuine public inquiry arriving over WhatsApp, most likely via the "Message"
 * button on the Google Business Profile. Mirrors the chat-widget escalation
 * flow (lib/chatWidget.ts's draftEscalationAnswerForApproval): draft a
 * best-guess answer grounded in PROPERTY_FACTS, create a chat_escalations row
 * (source: "whatsapp"), and text Seni the same YES/NO/EDIT: approval request
 * he already gets for website questions. handleEscalationReply's delivery
 * branch (below) sends the approved answer straight back to this same
 * WhatsApp number once he decides — no template needed, since the visitor's
 * own message just opened a 24-hour customer-service window.
 */
async function handlePublicWhatsAppInquiry(msg: Extract<IncomingWhatsAppMessage, { type: "text" }>): Promise<void> {
  const visitorName = msg.profileName || "WhatsApp inquiry";
  const question = msg.text.trim();
  if (!question) return;

  // Don't page Seni again for every follow-up message while one inquiry from
  // this same number is still awaiting his decision — just let the visitor
  // know it's being looked at.
  const existing = await getPendingWhatsAppEscalationByPhone(msg.from);
  if (existing) {
    await sendWhatsAppTextTo(
      msg.from,
      "Thanks for the extra detail — I'm still getting you an answer and will follow up shortly!"
    ).catch(() => {});
    return;
  }

  let aiDraftAnswer: string | undefined;
  try {
    aiDraftAnswer = await draftEscalationAnswerForApproval(question);
  } catch (err) {
    console.error("[whatsapp webhook] draftEscalationAnswerForApproval failed for public inquiry", err);
    // Non-fatal — Seni can still write his own answer with "EDIT: ...".
  }

  const escalation = await createChatEscalation({
    question,
    visitorName,
    visitorPhone: msg.from,
    aiDraftAnswer,
    source: "whatsapp",
  });

  const draftLine = aiDraftAnswer
    ? `Suggested reply:\n"${aiDraftAnswer}"\n\nReply YES to send it, NO to skip, or "EDIT: <your text>" to send your own wording.`
    : `No suggested reply could be drafted — reply "EDIT: <your text>" to send an answer, or NO to skip.`;

  // Try template-based approach first (durable even with closed session), fall back to free text if template not approved yet
  const approvalText = `New WhatsApp inquiry from ${visitorName} (${msg.from}) — looks like someone messaged your Google Business Profile:\n"${question}"\n\n${draftLine}`;
  let approvalWamid: string | undefined;
  try {
    approvalWamid = await sendGuestReplyApprovalTemplate({
      guestName: visitorName,
      propertyName: "Legacy Colombia",
      guestMessage: question,
      suggestedReply: aiDraftAnswer ?? "N/A",
    }).catch(() => undefined);
  } catch {
    approvalWamid = await sendWhatsAppText(approvalText).catch(() => undefined);
  }
  if (!approvalWamid) {
    approvalWamid = await sendWhatsAppText(approvalText).catch(() => undefined);
  }
  if (approvalWamid) await linkChatEscalationWamid(escalation.id, approvalWamid);

  await sendWhatsAppTextTo(
    msg.from,
    "Thanks for reaching out about Legacy Colombia! I'll get back to you personally in just a bit."
  ).catch(() => {});

  await logAiActivity({
    agentKey: WA_INQUIRY_AGENT_KEY,
    agentDisplayName: WA_INQUIRY_AGENT_NAME,
    task: "Draft answer to public WhatsApp inquiry",
    trigger: `Inbound WhatsApp text from ${visitorName} (${msg.from}): "${question.slice(0, 200)}"`,
    decision: aiDraftAnswer ? "drafted answer, awaiting Seni's approval" : "no draft — awaiting Seni's own wording",
    actionTaken: "Sent approval request to Seni via WhatsApp; acknowledged the inquirer",
    result: "pending",
  });
}

// Rolling log of Meta's delivery-status callbacks (sent/delivered/read/
// failed + error details). Meta reports exactly why an outbound message
// wasn't delivered via these callbacks — before 2026-08-15 they were
// silently discarded, which is why "API returned 200 + wamid but nothing
// arrived on Seni's phone" was so hard to diagnose. Read back via
// /api/admin/whatsapp-delivery.
const WA_STATUS_LOG_KEY = "wa:status-log";

async function recordStatusCallbacks(body: unknown): Promise<void> {
  try {
    const entries = (body as { entry?: unknown[] } | null)?.entry;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown[] })?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const statuses = (change as { value?: { statuses?: unknown[] } })?.value?.statuses;
        if (!Array.isArray(statuses)) continue;
        for (const raw of statuses) {
          const st = raw as Record<string, unknown>;
          const errors = Array.isArray(st.errors)
            ? (st.errors as Record<string, unknown>[]).map((e) => ({
                code: e.code,
                title: e.title,
                message: e.message,
                details: (e.error_data as Record<string, unknown> | undefined)?.details,
              }))
            : [];
          const rec = {
            at: new Date().toISOString(),
            wamid: st.id,
            status: st.status,
            recipient: st.recipient_id,
            errors,
          };
          console.log("[whatsapp webhook] delivery status:", JSON.stringify(rec));
          const { redisGet, redisSet } = await import("@/lib/redis");
          const prev = await redisGet(WA_STATUS_LOG_KEY).catch(() => null);
          const log = prev ? (JSON.parse(prev) as unknown[]) : [];
          log.unshift(rec);
          await redisSet(WA_STATUS_LOG_KEY, JSON.stringify(log.slice(0, 30))).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error("[whatsapp webhook] status-callback logging failed", err);
  }
}

// SECURITY FIX (2026-08-17 audit). This POST handler previously did no
// payload verification at all: authorization was isFromAuthorizedSender(
// msg.from), read straight out of attacker-controlled JSON. A forged POST
// claiming to come from Seni's number could approve a pending AI draft —
// which SENDS A REAL MESSAGE TO A REAL GUEST — or trigger a refund-adjacent
// bill-forward flow. The GET handler has always verified hub.verify_token;
// only POST was unprotected.
//
// Meta signs every webhook POST with HMAC-SHA256 over the RAW body using the
// app secret, in the X-Hub-Signature-256 header. Verifying it is the only
// way to know a payload actually came from Meta.
//
// Requires WHATSAPP_APP_SECRET (Meta for Developers -> App -> Settings ->
// Basic -> App Secret). Until it is set this stays open but logs loudly —
// same reasoning as the OwnerRez webhook: silently rejecting all real guest
// traffic would be a worse failure than the one being fixed.
async function verifyMetaSignature(req: NextRequest, rawBody: string): Promise<boolean> {
  const appSecret = (process.env.WHATSAPP_APP_SECRET || "").trim();
  if (!appSecret) {
    console.warn(
      "[whatsapp webhook] WHATSAPP_APP_SECRET is not set — accepting UNVERIFIED payloads. A forged POST could approve a draft and message a guest. Set it in Vercel."
    );
    return true;
  }
  const header = req.headers.get("x-hub-signature-256") ?? "";
  if (!header.startsWith("sha256=")) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const supplied = header.slice("sha256=".length);
  if (supplied.length !== expected.length) return false;
  // Compare the HEX STRINGS, not decoded buffers. Buffer.from(x, "hex")
  // silently truncates at the first non-hex character, so a 64-character
  // signature of garbage (e.g. "z".repeat(64)) decodes to a ZERO-byte
  // buffer while `expected` decodes to 32 bytes — and timingSafeEqual then
  // throws RangeError rather than returning false. That turned a forged
  // request into a 500, which Meta retry-storms, instead of a clean 401.
  // Both strings are fixed-length hex here, so a byte-wise compare over the
  // ASCII is equivalent and can't throw.
  return timingSafeEqual(Buffer.from(supplied, "ascii"), Buffer.from(expected, "ascii"));
}

export async function POST(req: NextRequest) {
  // Must read the RAW text: re-serializing the parsed object would change
  // key order/whitespace and the HMAC would never match.
  const rawBody = await req.text();
  if (!(await verifyMetaSignature(req, rawBody))) {
    console.warn("[whatsapp webhook] rejected a POST with a missing/invalid X-Hub-Signature-256");
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  const body = (() => {
    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      return null;
    }
  })();
  await recordStatusCallbacks(body);
  const incoming = parseIncomingWhatsAppMessages(body);

  for (const msg of incoming) {
    if (!isFromAuthorizedSender(msg.from)) {
      // Not Seni. Gabriel occasionally texts this same number too — that's
      // never a business inquiry, just ignore it (same as before this
      // feature existed). Anyone else texting in is a genuine public
      // inquiry — most likely someone who clicked the "Message" button on
      // the Google Business Profile, since that's the only place this
      // number is published for outside contact — so route it through the
      // same AI-draft + approval pathway as chat-widget escalations rather
      // than silently dropping it.
      if (isFromGabriel(msg.from)) continue;
      if (msg.type === "text") await handlePublicWhatsAppInquiry(msg);
      continue;
    }

    // A photo or PDF is unambiguous — the guest-reply/chat-widget approval
    // flows below are purely text-based ("yes"/"no"/custom reply), so any
    // media message is always a bill forward (see lib/billForward.ts).
    if (msg.type === "image" || msg.type === "document") {
      await handleBillForward(msg);
      continue;
    }

    const pending = await resolvePendingApproval(msg.contextWamid);

    if (!pending) {
      await sendWhatsAppText(
        "I don't have anything waiting on your approval right now — nothing to do with that message."
      ).catch(() => {});
      continue;
    }

    if (pending.kind === "escalation") {
      await handleEscalationReply(msg.text, pending.escalation);
      continue;
    }

    const draft = pending.draft;

    // getPendingDraftByWamid (used when Seni swipes to reply to a specific
    // approval text) deliberately returns a draft regardless of status, so
    // this check can tell him what happened rather than silently failing.
    // Without it, replying "YES" to an old approval text whose draft has
    // since been auto-superseded (see pendingDrafts.ts's createPendingDraft
    // — the guest sent something new before he got to this one) would send
    // a now-outdated reply to the guest.
    if (draft.status !== "pending") {
      await sendWhatsAppText(
        `That approval for ${draft.guestName ?? "the guest"} isn't current anymore (${draft.status === "superseded" ? "the guest sent a newer message since" : `already ${draft.status}`}) — check the Approvals tab for what's actually open.`
      ).catch(() => {});
      continue;
    }

    const reply = msg.text.trim();
    const isYes = /^y(es)?$/i.test(reply);
    const isNo = /^n(o)?$/i.test(reply);
    const editMatch = reply.match(/^edit:\s*([\s\S]+)$/i);

    if (isNo) {
      await resolvePendingDraft(draft.id, { status: "rejected" });
      await sendWhatsAppText(`Got it — discarded that reply to ${draft.guestName ?? "the guest"}.`).catch(() => {});
      await logAiActivity({
        agentKey: AGENT_KEY,
        agentDisplayName: AGENT_NAME,
        task: "Resolve guest reply approval",
        trigger: `Seni replied "NO" via WhatsApp for draft ${draft.id}`,
        decision: "rejected",
        actionTaken: "Discarded suggested reply — nothing sent to guest",
        result: "rejected",
      });
      continue;
    }

    // finalText is what actually goes to the guest (their language);
    // logText is what Seni actually wrote/approved, kept in English for
    // his own Sent log — same split as the dashboard Inbox uses.
    let finalText: string;
    let logText: string;
    if (isYes) {
      finalText = draft.draftReply; // already in the guest's language
      logText = draft.replyEnglish ?? draft.draftReply;
    } else if (editMatch) {
      const edited = editMatch[1].trim();
      const target = draft.language && draft.language !== "English" ? draft.language : null;
      finalText = target ? await translateToLanguage(edited, target) : edited;
      logText = edited;
    } else {
      // Safety net: a plain, unprefixed text used to be treated as an edited
      // reply and sent to the guest verbatim. That meant any unrelated
      // WhatsApp message to this number — including a test text — could get
      // delivered to a real guest whenever a draft happened to be pending
      // (see the #186 number-swap test incident, 2026-08-03, where "Test 4"
      // and "Test 5" went out to real guests this way). Now nothing goes out
      // unless it's explicitly "YES", "NO", or prefixed with "EDIT:".
      await sendWhatsAppText(
        `Nothing sent to ${draft.guestName ?? "the guest"} — reply "YES" to send the draft as-is, "NO" to discard it, or "EDIT: <your text>" to send your own wording.`
      ).catch(() => {});
      await logAiActivity({
        agentKey: AGENT_KEY,
        agentDisplayName: AGENT_NAME,
        task: "Guest reply approval safeguard",
        trigger: `Seni sent unrecognized text via WhatsApp for draft ${draft.id}: "${reply.slice(0, 200)}"`,
        decision: "ignored — missing YES/NO/EDIT: prefix",
        actionTaken: "Nothing sent to guest",
        result: "ignored",
      });
      continue;
    }

    try {
      await sendMessage(draft.threadId, finalText);
      await resolvePendingDraft(draft.id, { status: "sent", draftReply: finalText });
      await appendMessage({
        bookingId: draft.bookingId,
        guestId: draft.guestId,
        guestName: draft.guestName,
        subject: "AI-assisted reply (WhatsApp-approved)",
        language: "en",
        body: logText,
        status: "sent",
      });
      const gabrielNote = await notifyGabrielIfServiceRequest(draft);
      await sendWhatsAppText(`Sent to ${draft.guestName ?? "the guest"} ✅${gabrielNote}`).catch(() => {});
      await logAiActivity({
        agentKey: AGENT_KEY,
        agentDisplayName: AGENT_NAME,
        task: "Send guest reply",
        trigger: isYes
          ? `Seni replied "YES" via WhatsApp for draft ${draft.id}`
          : `Seni sent a custom reply via WhatsApp for draft ${draft.id}`,
        decision: isYes ? "approved as drafted" : "approved with edits",
        communicationSent: { channel: "ownerrez_message", threadId: draft.threadId, body: finalText },
        actionTaken: "Sent message to guest via OwnerRez",
        result: "sent",
      });
    } catch (err) {
      await resolvePendingDraft(draft.id, { status: "failed" });
      const message = err instanceof Error ? err.message : "Unknown error.";
      await sendWhatsAppText(
        `That reply to ${draft.guestName ?? "the guest"} failed to send: ${message.slice(0, 200)}`
      ).catch(() => {});
      await logAiActivity({
        agentKey: AGENT_KEY,
        agentDisplayName: AGENT_NAME,
        task: "Send guest reply",
        trigger: `Draft ${draft.id} (${draft.guestName ?? "guest"})`,
        error: message,
        result: "failed",
      });
    }
  }

  // Meta requires a 200 within a few seconds regardless of outcome, or it
  // will retry (and keep retrying) the same webhook delivery.
  return NextResponse.json({ ok: true });
}

// Handles Seni's WhatsApp reply to a website chat-widget escalation (see
// lib/chatEscalations.ts). Same YES/NO/EDIT: protocol as guest-reply
// approvals, but the outcome just marks the escalation "answered"/"rejected"
// — actual delivery to the visitor happens elsewhere: the widget's own poll
// endpoint picks it up live if they're still on the page, or the
// check-messages cron's fallback sweep emails/texts them if not (see
// api/public/chat-widget/poll/route.ts and the cron's fallback phase). This
// keeps the webhook itself fast and side-effect-light, matching Meta's
// requirement for a quick 200 response.
async function handleEscalationReply(rawText: string, escalation: ChatEscalation): Promise<void> {
  if (escalation.status !== "pending") {
    await sendWhatsAppText(
      `That website question from ${escalation.visitorName} isn't current anymore (already ${escalation.status}).`
    ).catch(() => {});
    return;
  }

  const reply = rawText.trim();
  const isYes = /^y(es)?$/i.test(reply);
  const isNo = /^n(o)?$/i.test(reply);
  // Language the website visitor wrote in, if it wasn't English — set at
  // escalation time by detectLanguageAndTranslateToEnglish (see
  // api/public/chat-widget/escalate). Null for English or for escalations
  // created before language capture existed.
  const escalationTarget =
    escalation.language && escalation.language.trim().toLowerCase() !== "english"
      ? escalation.language
      : null;

  const editMatch = reply.match(/^edit:\s*([\s\S]+)$/i);

  const isWhatsAppInquiry = escalation.source === "whatsapp";

  if (isNo) {
    await resolveChatEscalation(escalation.id, { status: "rejected" });
    // A website visitor who's left the page never sees a "rejected" state
    // either way (no fallback is sent — same as before), but someone who
    // messaged in directly over WhatsApp is sitting there waiting on a
    // reply, so leaving them with total silence would be poor practice for
    // a business inbox. Send a brief, graceful non-answer instead.
    if (isWhatsAppInquiry && escalation.visitorPhone) {
      await sendWhatsAppTextTo(
        escalation.visitorPhone,
        "Thanks so much for reaching out about Legacy Colombia — I'll follow up with more details soon!"
      ).catch(() => {});
    }
    await sendWhatsAppText(
      `Got it — skipped that ${isWhatsAppInquiry ? "WhatsApp" : "website"} question from ${escalation.visitorName}.`
    ).catch(() => {});
    await logAiActivity({
      agentKey: isWhatsAppInquiry ? WA_INQUIRY_AGENT_KEY : CHAT_AGENT_KEY,
      agentDisplayName: isWhatsAppInquiry ? WA_INQUIRY_AGENT_NAME : CHAT_AGENT_NAME,
      task: "Resolve chat escalation",
      trigger: `Seni replied "NO" via WhatsApp for escalation ${escalation.id}`,
      decision: "rejected",
      actionTaken: isWhatsAppInquiry
        ? "Sent a brief holding reply to the inquirer — no substantive answer given"
        : "Discarded suggested answer — nothing sent to visitor",
      result: "rejected",
    });
    return;
  }

  let finalAnswer: string;
  if (isYes) {
    if (!escalation.aiDraftAnswer) {
      await sendWhatsAppText(
        `No suggested answer was drafted for ${escalation.visitorName}'s question — reply "EDIT: <your answer>" to send your own wording, or "NO" to skip it.`
      ).catch(() => {});
      return;
    }
    // The AI draft was written in response to the visitor's own question, so
    // for a foreign-language inquiry it needs the same return trip as an
    // edited answer — Claude drafts these in English for Seni's approval.
    finalAnswer = escalationTarget
      ? await translateToLanguage(escalation.aiDraftAnswer, escalationTarget)
      : escalation.aiDraftAnswer;
  } else if (editMatch) {
    // Seni writes English; the visitor may not read it. Same rule the
    // guest-reply path above already applies (2026-08-17).
    const edited = editMatch[1].trim();
    finalAnswer = escalationTarget ? await translateToLanguage(edited, escalationTarget) : edited;
  } else {
    await sendWhatsAppText(
      `Nothing sent to ${escalation.visitorName} — reply "YES" to send the suggested answer, "NO" to skip it, or "EDIT: <your text>" to send your own wording.`
    ).catch(() => {});
    await logAiActivity({
      agentKey: CHAT_AGENT_KEY,
      agentDisplayName: CHAT_AGENT_NAME,
      task: "Chat-widget escalation approval safeguard",
      trigger: `Seni sent unrecognized text via WhatsApp for escalation ${escalation.id}: "${reply.slice(0, 200)}"`,
      decision: "ignored — missing YES/NO/EDIT: prefix",
      actionTaken: "Nothing sent to visitor",
      result: "ignored",
    });
    return;
  }

  await resolveChatEscalation(escalation.id, { status: "answered", finalAnswer });

  if (isWhatsAppInquiry && escalation.visitorPhone) {
    // The visitor messaged this WhatsApp number directly, so a 24-hour
    // customer-service window is already open — deliver the approved answer
    // immediately as a free-text reply, right back on the same thread they
    // started. No template, no poll, no fallback sweep needed (unlike the
    // website-widget path below).
    try {
      await sendWhatsAppTextTo(escalation.visitorPhone, finalAnswer);
      await sendWhatsAppText(`Sent to ${escalation.visitorName} on WhatsApp ✅`).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      await sendWhatsAppText(
        `Approved, but sending that reply to ${escalation.visitorName} on WhatsApp failed: ${message.slice(0, 200)}`
      ).catch(() => {});
    }
    await logAiActivity({
      agentKey: WA_INQUIRY_AGENT_KEY,
      agentDisplayName: WA_INQUIRY_AGENT_NAME,
      task: "Answer public WhatsApp inquiry",
      trigger: isYes
        ? `Seni replied "YES" via WhatsApp for escalation ${escalation.id}`
        : `Seni sent a custom reply via WhatsApp for escalation ${escalation.id}`,
      decision: isYes ? "approved as drafted" : "approved with edits",
      communicationSent: { channel: "whatsapp_direct", visitorName: escalation.visitorName, body: finalAnswer },
      actionTaken: "Sent reply directly back to the inquirer's WhatsApp number",
      result: "answered",
    });
    return;
  }

  await sendWhatsAppText(
    `Marked as answered for ${escalation.visitorName} ✅ — it'll show up live in their chat if they're still on the site, or by email/WhatsApp shortly if they've left.`
  ).catch(() => {});
  await logAiActivity({
    agentKey: CHAT_AGENT_KEY,
    agentDisplayName: CHAT_AGENT_NAME,
    task: "Answer chat-widget escalation",
    trigger: isYes
      ? `Seni replied "YES" via WhatsApp for escalation ${escalation.id}`
      : `Seni sent a custom reply via WhatsApp for escalation ${escalation.id}`,
    decision: isYes ? "approved as drafted" : "approved with edits",
    communicationSent: { channel: "chat_widget", visitorName: escalation.visitorName, body: finalAnswer },
    actionTaken: "Marked escalation answered — delivery via widget poll or cron fallback",
    result: "answered",
  });
}
