import { NextRequest, NextResponse } from "next/server";
import { config, isGmailSmtpConfigured } from "@/lib/config";
import { verifyGmailSmtp } from "@/lib/gmailSmtp";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs"; // SMTP needs raw TCP — not available on edge
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Which transport is live, and does it actually authenticate (2026-08-17)?
//
// Built because the last email outage was invisible: Resend returned a
// perfectly normal-looking config while silently refusing every recipient
// except the account owner. A route that opens a real SMTP connection and
// reports what the From address will literally be turns that class of
// failure into something you can see before sending to real people.
//
//   GET  /api/admin/email-transport?secret=…            → status + live SMTP auth check
//   POST /api/admin/email-transport?secret=…            → send a real test
//        { "to": "senisok1@gmail.com" }
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const gmailReady = isGmailSmtpConfigured();
  const check = gmailReady ? await verifyGmailSmtp() : { ok: false, error: "Not configured." };

  return NextResponse.json({
    activeTransport: gmailReady ? "gmail-smtp" : config.resendApiKey ? "resend" : "none",
    from: gmailReady ? `${config.gmailFromName} <${config.gmailUser}>` : config.reportEmailFrom,
    gmail: {
      configured: gmailReady,
      user: config.gmailUser || null,
      appPasswordLength: config.gmailAppPassword.length || 0,
      authenticates: check.ok,
      error: check.ok ? null : check.error,
    },
    resendFallback: Boolean(config.resendApiKey),
    canReachAnyRecipient: gmailReady && check.ok,
    note: gmailReady
      ? check.ok
        ? "Google Workspace SMTP is live. Onboarding emails and daily summaries can reach any address."
        : "Credentials are set but SMTP auth failed — check the app password and that 2-Step Verification is on."
      : "Set GMAIL_USER and GMAIL_APP_PASSWORD in Vercel, then redeploy.",
  });
}

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { to?: string };
  const to = body.to?.trim();
  if (!to) return NextResponse.json({ error: "to is required." }, { status: 400 });

  try {
    const messageId = await sendEmail({
      to,
      subject: "Legacy Dashboard — email transport test",
      html: "<p>If you're reading this, the dashboard can send email to any address.</p>",
      text: "If you're reading this, the dashboard can send email to any address.",
    });
    return NextResponse.json({
      ok: true,
      to,
      messageId,
      transport: isGmailSmtpConfigured() ? "gmail-smtp" : "resend",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error." },
      { status: 502 }
    );
  }
}
