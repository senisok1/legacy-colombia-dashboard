import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Resend domain status (2026-08-17). Onboarding emails to the team failed
// with a 403: the account is still on Resend's shared onboarding@resend.dev
// sender, which may ONLY deliver to the Resend account owner's own address.
// Every test send so far went to Seni himself, so this never surfaced — and
// it silently caps the per-property daily summaries at one recipient too.
// This reports which domains are registered and whether they're verified, so
// the fix is concrete rather than guesswork.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!config.resendApiKey) {
    return NextResponse.json({ error: "RESEND_API_KEY isn't set." }, { status: 400 });
  }

  const res = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${config.resendApiKey}` },
    cache: "no-store",
  });
  const json = (await res.json()) as {
    data?: { name: string; status: string; region?: string }[];
  };
  return NextResponse.json({
    currentFrom: config.reportEmailFrom,
    domains: (json.data ?? []).map((d) => ({ name: d.name, status: d.status, region: d.region })),
    note:
      "A domain must show status 'verified' AND REPORT_EMAIL_FROM must use that domain before email can reach anyone other than the Resend account owner.",
  });
}
