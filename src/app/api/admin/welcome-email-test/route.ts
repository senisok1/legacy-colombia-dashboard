import { NextRequest, NextResponse } from "next/server";
import { config, isEmailSendConfigured } from "@/lib/config";
import { buildWelcomeEmail } from "@/lib/teamWelcomeEmail";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// Preview / test-send the new-team-member welcome email without having to
// create a throwaway login (2026-08-17). Admin-secret gated, same as the
// other /api/admin/* utilities.
//
//   GET  ?secret=…&preview=1[&language=Spanish][&admin=1]  → returns the HTML
//   GET  ?secret=…&to=someone@example.com[&language=…]     → sends it
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const language = req.nextUrl.searchParams.get("language") || "English";
  const isAdmin = req.nextUrl.searchParams.get("admin") === "1";
  const to = req.nextUrl.searchParams.get("to");

  const origin = req.nextUrl.origin.includes("localhost")
    ? "https://crm.legacyestaterentals.com"
    : req.nextUrl.origin;

  const { subject, html, text } = buildWelcomeEmail({
    name: req.nextUrl.searchParams.get("name") || "Gabriel",
    email: req.nextUrl.searchParams.get("email") || "pm@legacycolombia.com",
    password: req.nextUrl.searchParams.get("password") || "ExamplePass123",
    language,
    isAdmin,
    properties: (req.nextUrl.searchParams.get("properties") || "Legacy Colombia")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    loginUrl: `${origin}/login`,
  });

  if (req.nextUrl.searchParams.get("preview") === "1" || !to) {
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (!isEmailSendConfigured()) {
    return NextResponse.json({ error: "Email isn't configured (missing RESEND_API_KEY)." }, { status: 400 });
  }

  try {
    const id = await sendEmail({ to, subject, html, text });
    return NextResponse.json({ ok: true, sentTo: to, subject, language, messageId: id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 502 }
    );
  }
}
