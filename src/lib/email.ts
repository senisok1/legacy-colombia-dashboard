import { config, isEmailConfigured } from "./config";

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
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<string> {
  if (!isEmailConfigured()) {
    throw new EmailError("Email isn't configured — missing RESEND_API_KEY or REPORT_EMAIL_TO.");
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
