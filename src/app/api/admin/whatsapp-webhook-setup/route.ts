import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Everything needed to re-point Meta's WhatsApp webhook at a secured
// callback URL (2026-08-17 audit) — the POST handler previously accepted
// any unauthenticated payload, and a forged one could approve a pending
// draft, which sends a real message to a real guest.
//
// Returns the exact Callback URL and Verify Token to paste into
// Meta for Developers -> WhatsApp -> Configuration -> Edit.
//
// WHY THE VERIFY TOKEN IS SAFE TO RETURN HERE. It is not a credential and
// grants no access to anything: it's an arbitrary string this app and Meta
// echo at each other once, during the GET handshake, to prove the URL owner
// configured the subscription (see config.ts's whatsappVerifyToken comment,
// "you can set this to anything"). The route is ADMIN_SECRET-gated anyway.
//
// WHATSAPP_WEBHOOK_SECRET is deliberately NOT returned in full — it's the
// thing actually protecting the endpoint. The URL is returned assembled so
// it can be pasted without ever displaying the secret on its own.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const webhookSecret = (process.env.WHATSAPP_WEBHOOK_SECRET || "").trim();
  const appSecret = (process.env.WHATSAPP_APP_SECRET || "").trim();
  const base = "https://crm.legacyestaterentals.com/api/whatsapp/webhook";

  return NextResponse.json({
    callbackUrl: webhookSecret ? `${base}?secret=${encodeURIComponent(webhookSecret)}` : base,
    verifyToken: config.whatsappVerifyToken || null,
    protection: appSecret
      ? "HMAC (WHATSAPP_APP_SECRET) — strongest; payload itself is signed"
      : webhookSecret
        ? "URL secret (WHATSAPP_WEBHOOK_SECRET) — authenticates the caller"
        : "NONE — endpoint currently accepts unverified payloads",
    note:
      "Paste callbackUrl + verifyToken into Meta for Developers -> WhatsApp -> Configuration -> Edit, then Verify and save. Adding WHATSAPP_APP_SECRET later upgrades this to full payload signing with no Meta change needed.",
  });
}
