import { NextRequest, NextResponse } from "next/server";
import { sendWhatsAppText, WhatsAppError } from "@/lib/whatsapp";
import { isWhatsAppConfigured, isDbConfigured } from "@/lib/config";
import { checkRateLimit, corsHeaders, getClientIp, handlePreflight, isAllowedOrigin } from "@/lib/publicApiGuard";
import { createChatEscalation, linkChatEscalationWamid } from "@/lib/chatEscalations";
import { draftEscalationAnswerForApproval, ChatWidgetError } from "@/lib/chatWidget";
import { logAiActivity } from "@/lib/aiActivity";

// Public, unauthenticated endpoint the chat widget (public/chat-widget.js)
// calls once a visitor has been asked for — and provided — their name,
// email, and phone, after the AI couldn't confidently answer their question
// (see lib/chatWidget.ts's needsEscalation). Unlike the old version of this
// route (which just fired a one-way WhatsApp notification with no way to
// reply), this now:
//   1. Drafts a fuller best-guess answer for Seni to review (never sent to
//      the visitor without his say-so).
//   2. Persists a chat_escalations row (see lib/chatEscalations.ts) so the
//      widget can poll for the outcome and the WhatsApp webhook can resolve
//      his YES/NO/EDIT: reply against it.
//   3. Texts Seni the same YES/NO/EDIT approval pattern already used for
//      guest-reply approvals, so he can answer from his own WhatsApp app.
// Same CORS + rate-limit treatment as the sibling route.ts — see
// lib/publicApiGuard.ts.

export const dynamic = "force-dynamic";
export const maxDuration = 30; // drafting the approval answer is one more Claude call than before

const AGENT_KEY = "chat_widget";
const AGENT_NAME = "AI Website Chat Widget";

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

const MAX_FIELD_LENGTH = 200;
const MAX_QUESTION_LENGTH = 1000;
const MAX_SUMMARY_LENGTH = 2000;

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req);
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }
  const headers = corsHeaders(origin);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, "chat-widget-escalate", RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests — please try again in a bit." },
      { status: 429, headers }
    );
  }

  const body = await req.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const visitorName = typeof body?.visitorName === "string" ? body.visitorName.trim() : "";
  const visitorEmail = typeof body?.visitorEmail === "string" ? body.visitorEmail.trim() : "";
  const visitorPhone = typeof body?.visitorPhone === "string" ? body.visitorPhone.trim() : "";
  const conversationSummary =
    typeof body?.conversationSummary === "string" ? body.conversationSummary.trim() : "";

  if (!visitorName || !visitorEmail || !visitorPhone) {
    return NextResponse.json(
      { error: "Name, email, and phone are all required so we can reach you." },
      { status: 400, headers }
    );
  }
  if (
    visitorName.length > MAX_FIELD_LENGTH ||
    visitorEmail.length > MAX_FIELD_LENGTH ||
    visitorPhone.length > MAX_FIELD_LENGTH ||
    question.length > MAX_QUESTION_LENGTH ||
    conversationSummary.length > MAX_SUMMARY_LENGTH
  ) {
    return NextResponse.json({ error: "One of the fields is too long." }, { status: 400, headers });
  }

  if (!isWhatsAppConfigured()) {
    console.error("[chat-widget/escalate] WhatsApp isn't configured — can't notify Seni.");
    return NextResponse.json(
      { error: "Couldn't send your message right now — please try again later." },
      { status: 500, headers }
    );
  }
  if (!isDbConfigured()) {
    console.error("[chat-widget/escalate] Database isn't configured — can't persist an escalation.");
    return NextResponse.json(
      { error: "Couldn't send your message right now — please try again later." },
      { status: 500, headers }
    );
  }

  try {
    let aiDraftAnswer: string | undefined;
    try {
      aiDraftAnswer = await draftEscalationAnswerForApproval(
        question || "(no question captured)",
        conversationSummary || undefined
      );
    } catch (err) {
      // Non-fatal: Seni can still answer with EDIT: even with no AI draft to
      // approve as-is — better to still create the escalation than to fail
      // the visitor's request entirely over a drafting hiccup.
      console.error("[chat-widget/escalate] draftEscalationAnswerForApproval failed", err);
    }

    const escalation = await createChatEscalation({
      question: question || "(no question captured)",
      conversationSummary: conversationSummary || undefined,
      visitorName,
      visitorEmail,
      visitorPhone,
      aiDraftAnswer,
    });

    const summaryLine = conversationSummary ? `\n\nConversation so far:\n${conversationSummary}` : "";
    const draftLine = aiDraftAnswer
      ? `\n\nSuggested answer:\n"${aiDraftAnswer}"\n\nReply YES to send this, NO to skip it, or EDIT: <your own answer> to send that instead.`
      : `\n\n(Couldn't draft a suggested answer — reply EDIT: <your answer> to send one, or NO to skip.)`;
    const text = `🌐 Website chat — new question from ${visitorName} (${visitorEmail} / ${visitorPhone}):\n"${question || "(no question captured)"}"${draftLine}${summaryLine}`;

    try {
      const wamid = await sendWhatsAppText(text);
      await linkChatEscalationWamid(escalation.id, wamid);
    } catch (err) {
      // The escalation row still exists even if the WhatsApp text failed —
      // log it, but don't fail the visitor's request over a delivery hiccup
      // on Seni's side; he can still find it if a fallback sweep is added
      // for stuck-pending rows later.
      const detail = err instanceof WhatsAppError ? err.message : String(err);
      console.error("[chat-widget/escalate] Failed to notify Seni via WhatsApp:", detail);
    }

    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Escalate visitor question",
      trigger: `Visitor ${visitorName} asked: "${question}"`,
      dataReviewed: { visitorEmail, visitorPhone, conversationSummary },
      decision: aiDraftAnswer ?? "(no draft — needs Seni's own wording)",
      policyUsed: "Best-guess answer grounded in property facts + previously answered questions",
      actionTaken: "Created chat_escalations row, texted Seni for YES/NO/EDIT approval",
      result: "pending_approval",
    });

    return NextResponse.json({ ok: true, escalationId: escalation.id }, { headers });
  } catch (err) {
    console.error("[chat-widget/escalate] Failed to create escalation:", err instanceof Error ? err.message : err);
    const notConfigured = err instanceof ChatWidgetError && /ANTHROPIC_API_KEY/.test(err.message);
    return NextResponse.json(
      {
        error: notConfigured
          ? "Chat isn't fully set up yet."
          : "Couldn't send your message right now — please try again later.",
      },
      { status: 500, headers }
    );
  }
}
