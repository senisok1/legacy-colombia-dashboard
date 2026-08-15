import { config, isAiReplyConfigured } from "./config";
import { resolveAnthropicApiKey } from "./credentials";

// Reads a photo or PDF of a bill/invoice (forwarded via WhatsApp, see
// lib/billForward.ts) and pulls out structured fields using Claude's vision
// input. This is the "detection" half of Phase 4's tracking/detection-only
// scope (see docs/VISION.md) — it only ever produces a suggested bill
// record for Seni to review in the Bill Pay tab; it never approves,
// schedules, or sends a payment.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export class BillExtractError extends Error {}

export type ExtractedBill = {
  vendorName: string | null;
  /** Major-unit amount, e.g. 185.00 for $185. Null if illegible. */
  amount: number | null;
  currency: string;
  invoiceNumber: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  category: string | null;
  confidence: "high" | "medium" | "low";
  notes: string | null;
};

const SYSTEM_PROMPT = `You extract structured bill/invoice data from a photo or scan that a short-term rental property owner forwarded over WhatsApp. This is for expense tracking only — nothing you extract triggers a payment.

Respond with ONLY a single JSON object (no markdown fences, no other text before or after it), with exactly these keys:
{
  "vendor_name": "the business/vendor name being billed, or null if illegible",
  "amount": a number in the invoice's major currency unit (e.g. 185.00 for $185.00), or null if illegible,
  "currency": "USD" or "COP" or another ISO code if you can identify it, default to "USD" if genuinely unclear,
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "category": "a short category guess like Pool, Landscaping, Utilities, Cleaning, Supplies, or null",
  "confidence": "high", "medium", or "low" — how confident you are this is a real, legible bill/invoice with a clear vendor name and total amount,
  "notes": "anything the reviewer should know (illegible parts, ambiguity, multiple totals, handwriting, etc.), or null"
}

If the image/document is not a bill or invoice at all, set confidence to "low" and explain why in notes. Never guess a vendor name or amount you can't actually read — use null instead.`;

/**
 * Calls Claude with a vision input (image or PDF) and parses the structured
 * bill data out of the response. Throws BillExtractError if the API isn't
 * configured or the call fails outright; a genuinely unreadable image still
 * returns a normal ExtractedBill with confidence "low" rather than throwing,
 * so callers can surface that to Seni instead of crashing.
 */
export async function extractBillFromMedia(params: {
  bytes: Buffer;
  mimeType: string;
  organizationId?: string;
}): Promise<ExtractedBill> {
  if (!isAiReplyConfigured()) {
    throw new BillExtractError("ANTHROPIC_API_KEY isn't set (or has no credits) — can't extract bill data yet.");
  }

  const isPdf = params.mimeType === "application/pdf";
  const isImage = params.mimeType.startsWith("image/");
  if (!isPdf && !isImage) {
    throw new BillExtractError(`Unsupported file type for bill extraction: ${params.mimeType}`);
  }

  const base64 = params.bytes.toString("base64");
  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: params.mimeType, data: base64 } };

  const apiKey = await resolveAnthropicApiKey(params.organizationId);
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [contentBlock, { type: "text", text: "Extract the bill data from this file." }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new BillExtractError(`Anthropic API returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new BillExtractError("Anthropic API returned no extraction text.");

  return parseExtractedBill(text);
}

function parseExtractedBill(rawText: string): ExtractedBill {
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low";
    return {
      vendorName: typeof parsed.vendor_name === "string" && parsed.vendor_name.trim() ? parsed.vendor_name.trim() : null,
      amount: typeof parsed.amount === "number" && Number.isFinite(parsed.amount) ? parsed.amount : null,
      currency: typeof parsed.currency === "string" && parsed.currency.trim() ? parsed.currency.trim().toUpperCase() : "USD",
      invoiceNumber: typeof parsed.invoice_number === "string" && parsed.invoice_number.trim() ? parsed.invoice_number.trim() : null,
      invoiceDate: typeof parsed.invoice_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.invoice_date) ? parsed.invoice_date : null,
      dueDate: typeof parsed.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date) ? parsed.due_date : null,
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null,
      confidence,
      notes: typeof parsed.notes === "string" && parsed.notes.trim() ? parsed.notes.trim() : null,
    };
  } catch {
    // Model didn't return valid JSON — degrade to a low-confidence, empty
    // result rather than throw, so the caller can tell Seni to enter it
    // manually instead of crashing the webhook.
    return {
      vendorName: null,
      amount: null,
      currency: "USD",
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      category: null,
      confidence: "low",
      notes: "Couldn't parse a structured result from this file.",
    };
  }
}
