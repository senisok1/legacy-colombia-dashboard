import { sendEmail } from "./email";
import { isEmailSendConfigured } from "./config";
import { sendTeamTaskRequestTemplate, sendWhatsAppTextTo, WhatsAppError } from "./whatsapp";
import { linkNotifyWamid, type TeamRequest } from "./teamRequests";
import { translateToLanguage } from "./translate";

// Team Request notifications (2026-08-18, Seni's ask). Two moments:
//   1. A request is created -> the TAGGED person is notified (WhatsApp
//      template first for durable delivery, free text as a best-effort
//      fallback, plus email — see the header comment on
//      config.whatsappTeamTaskRequestTemplate for why the template matters
//      here specifically: unlike Seni's own approval alerts, the recipient
//      may have never messaged this WhatsApp number before, so there's no
//      guaranteed-open 24h session for free text to ride on).
//   2. The tagged person decides -> the ORIGINAL REQUESTER is notified of the
//      outcome. This side is WhatsApp-best-effort + email only (no new
//      template) — see the module-level note below for why that's an
//      acceptable, deliberate scope line rather than a gap.
//
// Both channels are independently best-effort: a failed WhatsApp send never
// blocks the email, and vice versa. Every call here is wrapped by its caller
// in a way that never blocks the actual accept/deny/create from completing —
// see api/team-requests/route.ts.

export type NotifyPerson = {
  email: string;
  name: string | null;
  phone: string | null;
  language: string;
};

function displayNeededBy(neededBy: string | null): string {
  if (!neededBy) return "no specific date";
  const d = new Date(`${neededBy}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? neededBy
    : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

async function localize(text: string, language: string, organizationId?: string): Promise<string> {
  if (!language || language.toLowerCase() === "english") return text;
  try {
    return await translateToLanguage(text, language, organizationId);
  } catch {
    return text; // non-fatal — English is still readable, just not their language
  }
}

/**
 * Notifies the tagged teammate that a new request needs their accept/deny.
 * Returns what actually went out so the caller can surface it in the
 * dashboard response (mirrors sendWelcome's emailSent/emailError pattern in
 * api/settings/users/route.ts) rather than claiming success unconditionally.
 */
export async function notifyTaggedPersonOfNewRequest(
  request: TeamRequest,
  tagged: NotifyPerson,
  loginUrl: string,
  organizationId: string
): Promise<{ whatsappSent: boolean; whatsappError?: string; emailSent: boolean; emailError?: string }> {
  const requesterName = request.requestedByName || request.requestedByEmail;
  const neededByText = displayNeededBy(request.neededBy);
  const description = request.description || "(no further details)";

  let whatsappSent = false;
  let whatsappError: string | undefined;
  if (tagged.phone) {
    try {
      const wamid = await sendTeamTaskRequestTemplate(
        {
          to: tagged.phone,
          requesterName,
          title: request.title,
          neededBy: neededByText,
          description,
        },
        organizationId
      );
      await linkNotifyWamid(request.id, organizationId, wamid).catch(() => {});
      whatsappSent = true;
    } catch (err) {
      // Template not approved yet (or Meta rejected it) — fall back to free
      // text. Only actually delivers if this person already has an open 24h
      // session with this WhatsApp number (e.g. they've messaged it before);
      // see config.whatsappTeamTaskRequestTemplate's comment.
      whatsappError = err instanceof Error ? err.message : "Unknown error.";
      try {
        const fallbackEnglish = `📋 New task request from ${requesterName}: "${request.title}" — needed by ${neededByText}.\n${description}\n\nReply YES to accept or NO to decline.`;
        const localized = await localize(fallbackEnglish, tagged.language, organizationId);
        await sendWhatsAppTextTo(tagged.phone, localized, organizationId);
        whatsappSent = true;
        whatsappError = undefined;
      } catch (fallbackErr) {
        whatsappError =
          fallbackErr instanceof WhatsAppError
            ? `${whatsappError} (fallback also failed: ${fallbackErr.message})`
            : whatsappError;
      }
    }
  } else {
    whatsappError = "No WhatsApp number on file for this teammate.";
  }

  let emailSent = false;
  let emailError: string | undefined;
  if (isEmailSendConfigured()) {
    try {
      const subjectEnglish = `New task request: ${request.title}`;
      const bodyEnglish = `${requesterName} asked you to accept or deny a task:\n\n"${request.title}"\nNeeded by: ${neededByText}\n${description}\n\nOpen the Team Activity Log tab to accept or deny it: ${loginUrl}`;
      const [subject, body] = await Promise.all([
        localize(subjectEnglish, tagged.language, organizationId),
        localize(bodyEnglish, tagged.language, organizationId),
      ]);
      const html = `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#1c1917;">${body
        .split("\n")
        .map((line) => `<p style="margin:0 0 10px;">${line || "&nbsp;"}</p>`)
        .join("")}</div>`;
      await sendEmail({ to: tagged.email, subject, html, text: body });
      emailSent = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : "Unknown email error.";
    }
  } else {
    emailError = "Email isn't configured (missing RESEND_API_KEY).";
  }

  return { whatsappSent, whatsappError, emailSent, emailError };
}

/**
 * Notifies the original requester once the tagged person accepts or
 * declines. Deliberately NOT its own Meta template — that would be a second
 * template submission for a lower-stakes notification (the requester
 * already knows they made a request; this is a status update, not a
 * decision needed from them). WhatsApp delivery here is best-effort (only
 * reaches the requester if their own 24h session happens to be open, exactly
 * like every other free-text send in this app); email is the channel that
 * reliably lands regardless, so it's treated as the important half here.
 */
export async function notifyRequesterOfDecision(
  request: TeamRequest,
  requester: NotifyPerson,
  loginUrl: string,
  organizationId: string
): Promise<{ whatsappSent: boolean; emailSent: boolean }> {
  const decisionWord = request.accepted ? "accepted" : "declined";
  const decidedBy = request.decidedByName || request.taggedName || request.taggedEmail;

  let whatsappSent = false;
  if (requester.phone) {
    try {
      const english = request.accepted
        ? `✅ ${decidedBy} accepted your task request "${request.title}".`
        : `${decidedBy} declined your task request "${request.title}"${request.declineReason ? `: ${request.declineReason}` : "."}`;
      const localized = await localize(english, requester.language, organizationId);
      await sendWhatsAppTextTo(requester.phone, localized, organizationId);
      whatsappSent = true;
    } catch {
      whatsappSent = false; // best-effort — no template backstop by design, see header comment
    }
  }

  let emailSent = false;
  if (isEmailSendConfigured()) {
    try {
      const subjectEnglish = `Your task request was ${decisionWord}: ${request.title}`;
      const bodyEnglish = request.accepted
        ? `${decidedBy} accepted your task request:\n\n"${request.title}"\n\nSee it in the Team Activity Log tab: ${loginUrl}`
        : `${decidedBy} declined your task request:\n\n"${request.title}"${
            request.declineReason ? `\nReason: ${request.declineReason}` : ""
          }\n\nSee it in the Team Activity Log tab: ${loginUrl}`;
      const [subject, body] = await Promise.all([
        localize(subjectEnglish, requester.language, organizationId),
        localize(bodyEnglish, requester.language, organizationId),
      ]);
      const html = `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#1c1917;">${body
        .split("\n")
        .map((line) => `<p style="margin:0 0 10px;">${line || "&nbsp;"}</p>`)
        .join("")}</div>`;
      await sendEmail({ to: requester.email, subject, html, text: body });
      emailSent = true;
    } catch {
      emailSent = false;
    }
  }

  return { whatsappSent, emailSent };
}
