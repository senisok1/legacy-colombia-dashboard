import nodemailer from "nodemailer";
import { config } from "./config";

// Google Workspace SMTP transport (2026-08-17).
//
// WHY THIS EXISTS. Resend's shared onboarding@resend.dev sender only
// delivers to the Resend account owner, so every team onboarding email and
// every per-property daily summary could only ever reach Seni. Lifting that
// needs a verified sending domain → DNS records on legacyestaterentals.com →
// a Cloudflare account Seni turned out not to control. Google Workspace
// already runs mail for that exact domain with SPF and DKIM published and
// passing, so sending through it needs no DNS change and no third party.
//
// AUTH. A Google App Password, not the account password: a 16-character
// per-application secret that can be revoked on its own and can't be used to
// sign in to the account interactively. Requires 2-Step Verification.
//
// FROM ADDRESS. Gmail rewrites the From header to the authenticated mailbox
// unless the address is a verified "Send mail as" alias on that mailbox, so
// we build From from GMAIL_USER rather than REPORT_EMAIL_FROM. Setting a
// From that Gmail doesn't own would either be silently rewritten (confusing)
// or rejected — better to be explicit about what actually goes out.
//
// LIMITS. Workspace allows roughly 2,000 recipients/day per user; onboarding
// plus five daily summaries is nowhere near it. Connections are pooled per
// warm serverless instance, but a cold start opens a fresh one — fine at
// this volume.

let cached: nodemailer.Transporter | null = null;

function transporter(): nodemailer.Transporter {
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // implicit TLS; avoids the STARTTLS upgrade race on 587
    auth: {
      user: config.gmailUser,
      // App passwords are displayed as "abcd efgh ijkl mnop"; config strips
      // the spaces, since pasting the displayed form is the common case and
      // Google rejects it verbatim.
      pass: config.gmailAppPassword,
    },
  });
  return cached;
}

/** Header-injection guard: a newline in a display name would let arbitrary
 * headers be appended. Names here come from config, but this is cheap. */
function safeName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").trim();
}

export async function sendViaGmail({
  to,
  subject,
  html,
  text,
  cc,
  bcc,
  replyTo,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}): Promise<string> {
  const info = await transporter().sendMail({
    from: `${safeName(config.gmailFromName)} <${config.gmailUser}>`,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
    ...(cc && cc.length ? { cc } : {}),
    ...(bcc && bcc.length ? { bcc } : {}),
    ...(replyTo ? { replyTo } : {}),
  });
  return info.messageId;
}

/** Opens a connection and authenticates without sending, so the app-password
 * setup can be checked from an admin route before anything real goes out. */
export async function verifyGmailSmtp(): Promise<{ ok: boolean; error?: string }> {
  try {
    await transporter().verify();
    return { ok: true };
  } catch (err) {
    cached = null; // don't cache a transport that failed to authenticate
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
  }
}
