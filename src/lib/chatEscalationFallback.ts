import { isChatReplyTemplateConfigured, isEmailSendConfigured } from "./config";
import { getChatEscalationsNeedingFallback, markFallbackSent } from "./chatEscalations";
import { sendEmail, EmailError } from "./email";
import { sendChatWidgetAnswerViaWhatsApp, sendWhatsAppText, WhatsAppError } from "./whatsapp";
import { logAiActivity } from "./aiActivity";
import type { ChatEscalation } from "./types";

// Delivers an answered chat-widget escalation to a visitor who's no longer
// on the page — see db/migrations/0011_chat_widget.sql's header comment for
// the full lifecycle. Called from api/cron/check-messages (already pinged
// externally every 1 minute — see project notes on Vercel Hobby's cron
// frequency cap) rather than a separate cron, since this is a lightweight
// DB sweep, not worth its own scheduler entry.
//
// Attempts BOTH channels independently when the visitor left both an email
// and a phone (the widget now requires both — see public/chat-widget.js) —
// better odds of actually reaching them than picking just one, and a
// visitor getting the same answer twice by two channels is a fine
// trade-off for reliability.

const STALE_MINUTES = 10; // matches Seni's explicit "10 min" spec

function emailHtml(escalation: ChatEscalation): string {
  const answer = escalation.finalAnswer ?? "";
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
  <p>Hi ${escapeHtml(escalation.visitorName)},</p>
  <p>Thanks for reaching out to Legacy Colombia! Here's the answer to your question:</p>
  <p><em>"${escapeHtml(escalation.question)}"</em></p>
  <p style="background:#f7f5f2;border-radius:8px;padding:14px 16px;white-space:pre-wrap;">${escapeHtml(answer)}</p>
  <p>Let us know if you have any other questions!</p>
  <p>— Legacy Colombia</p>
</div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function deliverOne(escalation: ChatEscalation, organizationId?: string): Promise<string[]> {
  const channels: string[] = [];

  if (escalation.visitorEmail && isEmailSendConfigured()) {
    try {
      await sendEmail({
        to: escalation.visitorEmail,
        subject: "Your question about Legacy Colombia",
        html: emailHtml(escalation),
        text: `Hi ${escalation.visitorName},\n\nThanks for reaching out to Legacy Colombia! Here's the answer to your question:\n"${escalation.question}"\n\n${escalation.finalAnswer}\n\n— Legacy Colombia`,
      });
      channels.push("email");
    } catch (err) {
      const detail = err instanceof EmailError ? err.message : String(err);
      console.error(`[chatEscalationFallback] email failed for ${escalation.id}`, detail);
    }
  }

  if (escalation.visitorPhone && isChatReplyTemplateConfigured()) {
    try {
      await sendChatWidgetAnswerViaWhatsApp(
        {
          visitorPhone: escalation.visitorPhone,
          visitorName: escalation.visitorName,
          answer: escalation.finalAnswer ?? "",
        },
        organizationId
      );
      channels.push("whatsapp");
    } catch (err) {
      const detail = err instanceof WhatsAppError ? err.message : String(err);
      console.error(`[chatEscalationFallback] whatsapp failed for ${escalation.id}`, detail);
    }
  }

  return channels;
}

export async function sweepChatEscalationFallbacks(organizationId?: string): Promise<{
  processed: number;
  delivered: { id: string; channels: string[] }[];
  errors: { id: string; error: string }[];
}> {
  const errors: { id: string; error: string }[] = [];
  const delivered: { id: string; channels: string[] }[] = [];

  let stale: ChatEscalation[] = [];
  try {
    stale = await getChatEscalationsNeedingFallback(STALE_MINUTES, organizationId);
  } catch (err) {
    return { processed: 0, delivered, errors: [{ id: "n/a", error: err instanceof Error ? err.message : String(err) }] };
  }

  for (const escalation of stale) {
    // Belt-and-suspenders (2026-08-17 audit): the query in
    // getChatEscalationsNeedingFallback now filters to source = 'website',
    // because WhatsApp-sourced inquiries are already delivered synchronously
    // by the WhatsApp webhook's approval branch — re-sending them here was
    // the double-delivery bug. Guard again at the point of send so a future
    // query change (or a new caller) can't quietly reintroduce it.
    if (escalation.source !== "website") continue;
    try {
      const channels = await deliverOne(escalation, organizationId);
      await markFallbackSent(escalation.id, channels.length ? channels.join("+") : "none", organizationId);

      if (channels.length) {
        delivered.push({ id: escalation.id, channels });
        await sendWhatsAppText(
          `📤 Follow-up sent to ${escalation.visitorName} via ${channels.join(" + ")} (they'd left the chat).`,
          organizationId
        ).catch(() => {});
      } else {
        await sendWhatsAppText(
          `⚠️ Couldn't deliver the answer to ${escalation.visitorName} — no email/WhatsApp fallback channel worked. You may want to follow up with them directly.`,
          organizationId
        ).catch(() => {});
      }

      await logAiActivity(
        {
          agentKey: "chat_widget",
          agentDisplayName: "AI Website Chat Widget",
          task: "Deliver escalation fallback",
          trigger: `Escalation ${escalation.id} (${escalation.visitorName}) answered but not picked up live within ${STALE_MINUTES} min`,
          actionTaken: channels.length ? `Delivered via ${channels.join("+")}` : "No channel available/succeeded",
          result: channels.length ? "sent" : "failed",
        },
        organizationId
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      errors.push({ id: escalation.id, error: message });
      await logAiActivity(
        {
          agentKey: "chat_widget",
          agentDisplayName: "AI Website Chat Widget",
          task: "Deliver escalation fallback",
          trigger: `Escalation ${escalation.id}`,
          error: message,
          result: "failed",
        },
        organizationId
      );
    }
  }

  return { processed: stale.length, delivered, errors };
}
