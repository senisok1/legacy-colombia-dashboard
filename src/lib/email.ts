import { config, isEmailConfigured, isGmailSmtpConfigured } from "./config";
import { sendViaGmail } from "./gmailSmtp";

// Thin wrapper around Resend's REST API — same "call the provider's HTTP
// API directly, no SDK" style as lib/whatsapp.ts's Meta Graph API calls.
// Second delivery channel for the daily executive report (see
// lib/executiveReport.ts and api/cron/daily-report), alongside WhatsApp.
// Resend was chosen over SMTP/Gmail because it needs no domain verification
// to start (their shared onboarding@resend.dev sender works immediately)
// and, like every other third-party credential in this app, Seni creates
// the account and hands over just the API key — this file never sees or
// needs a password.

export class EmailError extends Error {}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  cc,
  bcc,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Copied recipients — used so Seni stays in the loop on team onboarding
   * emails without those going to him alone (2026-08-17). */
  cc?: string | string[];
  /** Blind copy. Preferred over cc for team onboarding: a cc puts Seni's
   * personal address in every recipient's headers, and onboarding batches go
   * to several people at once, so each of them would also see the others.
   * bcc keeps him in the loop without exposing anyone (2026-08-17). */
  bcc?: string | string[];
}): Promise<string> {
  if (!isEmailConfigured()) {
    throw new EmailError(
      "Email isn't configured — set GMAIL_USER + GMAIL_APP_PASSWORD (preferred) or RESEND_API_KEY, plus REPORT_EMAIL_TO."
    );
  }

  // Google Workspace SMTP wins when available: it can reach any recipient,
  // whereas Resend on an unverified domain silently refuses everyone except
  // the Resend account owner. Resend stays as the fallback so a missing or
  // revoked app password degrades instead of breaking outright.
  if (isGmailSmtpConfigured()) {
    return sendViaGmail({ to, subject, html, text, cc, bcc });
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.reportEmailFrom,
      to: [to],
      subject,
      html,
      ...(text ? { text } : {}),
      ...(cc && cc.length ? { cc: Array.isArray(cc) ? cc : [cc] } : {}),
      ...(bcc && bcc.length ? { bcc: Array.isArray(bcc) ? bcc : [bcc] } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmailError(`Email send returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new EmailError("Email send succeeded but returned no message id.");
  return data.id;
}
