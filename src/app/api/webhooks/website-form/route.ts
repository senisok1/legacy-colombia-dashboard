import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured, isWhatsAppConfigured } from "@/lib/config";
import { upsertMarketingContactFromWebsite } from "@/lib/marketingContacts";
import { sendWhatsAppText } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

// Receives Elementor Pro's "Webhook" form action (Form settings -> Actions
// After Submit -> Webhook) for any lead-capture form on legacycolombia.com
// (availability requests, rate-guide downloads, exit-intent popups, etc.)
// and drops the contact into marketing_contacts — see
// lib/marketingContacts.ts's upsertMarketingContactFromWebsite().
//
// Elementor's webhook payload shape varies by version/config: sometimes a
// flat { field_id: value } object, sometimes { fields: { field_id: { id,
// title, value, raw_value } } }. collectCandidates() below handles both by
// walking whichever shape is present and matching field id/title/key
// against name/email/phone patterns, so this doesn't need to be re-tuned
// every time Seni edits a form's field ids. If a submission doesn't parse
// (no email found), the 400 response echoes back the field keys it *did*
// see, so we can extend the patterns instead of guessing blind.

type FieldCandidate = { key: string; value: string };

function collectCandidates(body: unknown): FieldCandidate[] {
  const out: FieldCandidate[] = [];
  if (!body || typeof body !== "object") return out;
  const container =
    "fields" in body && typeof (body as Record<string, unknown>).fields === "object"
      ? (body as Record<string, unknown>).fields
      : body;
  if (!container || typeof container !== "object") return out;

  for (const [key, raw] of Object.entries(container as Record<string, unknown>)) {
    if (raw && typeof raw === "object") {
      const f = raw as Record<string, unknown>;
      const value = f.value ?? f.raw_value;
      const label = (f.title as string) || (f.id as string) || key;
      if (typeof value === "string" && value.trim()) out.push({ key: String(label), value: value.trim() });
    } else if (typeof raw === "string" && raw.trim()) {
      out.push({ key, value: raw.trim() });
    }
  }
  return out;
}

function pick(candidates: FieldCandidate[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const hit = candidates.find((c) => pattern.test(c.key));
    if (hit) return hit.value;
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  if (!config.websiteFormWebhookSecret) {
    return NextResponse.json({ error: "WEBSITE_FORM_WEBHOOK_SECRET isn't set yet." }, { status: 501 });
  }
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== config.websiteFormWebhookSecret) {
    return NextResponse.json({ error: "Invalid or missing secret." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const candidates = collectCandidates(body);

  const email = pick(candidates, [/^e-?mail$/i, /e-?mail/i]);
  if (!email || !email.includes("@")) {
    return NextResponse.json(
      { error: "No email field found in submission.", sawFields: candidates.map((c) => c.key) },
      { status: 400 }
    );
  }

  const phone = pick(candidates, [/^phone$/i, /phone|tel|mobile|whatsapp/i]);
  const fullName = pick(candidates, [/^name$/i, /full.?name/i]);
  const firstName = pick(candidates, [/first.?name/i]) ?? fullName?.split(/\s+/)[0];
  const lastName = pick(candidates, [/last.?name|surname/i]) ?? (fullName?.split(/\s+/).slice(1).join(" ") || undefined);
  // Best-effort extras for the WhatsApp ping below — not required, and not
  // stored on the marketing_contacts row itself (that table has no message/
  // dates columns). Purely to give Seni useful context in the alert text.
  const message = pick(candidates, [/message|comment|note|question/i]);
  const arrival = pick(candidates, [/arrival|check.?in|start.?date/i]);
  const departure = pick(candidates, [/departure|check.?out|end.?date/i]);

  const contact = await upsertMarketingContactFromWebsite({ email, firstName, lastName, phone });

  // Real-time WhatsApp ping for a brand-new website inquiry — previously
  // this webhook only ever silently saved to marketing_contacts (visible
  // later in the Sales Pipeline tab), with no notification of any kind.
  // Added 2026-08-06 per Seni's ask to be pinged for "any inquiries or
  // bookings." Best-effort: a WhatsApp send failure here must never turn an
  // otherwise-successful lead capture into an error response for Elementor.
  if (isWhatsAppConfigured()) {
    try {
      const name = fullName || [firstName, lastName].filter(Boolean).join(" ") || "Someone";
      const lines = [
        `📩 New website inquiry from ${name}`,
        `Email: ${email}`,
        phone ? `Phone: ${phone}` : null,
        arrival || departure ? `Dates: ${arrival ?? "?"} → ${departure ?? "?"}` : null,
        message ? `Message: "${message}"` : null,
      ].filter(Boolean);
      await sendWhatsAppText(lines.join("\n"));
    } catch (err) {
      console.error("[webhooks/website-form] WhatsApp notify failed", err);
    }
  }

  return NextResponse.json({ ok: true, contact });
}
