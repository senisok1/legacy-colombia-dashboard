import { downloadWhatsAppMedia, WhatsAppError } from "./whatsapp";

// Confirmation replies REMOVED 2026-08-17 (Seni: WhatsApp is only for
// inquiries, guest messages and new bookings). Forwarding a bill photo still
// reads it and files it in Bill Pay exactly as before — it just doesn't
// message back. Outcomes, including failures, are recorded in the AI
// Activity log and the bill itself appears in the Bill Pay tab, so nothing
// is lost, it's just no longer chatty. reply() keeps the call sites intact
// so restoring this is a one-line change.
async function reply(_text: string): Promise<void> {
  // intentionally silent — see note above
}
import { extractBillFromMedia, BillExtractError } from "./billExtract";
import { createBill, findOrCreateVendorByName } from "./billPay";
import { logAiActivity } from "./aiActivity";
import { isAiReplyConfigured } from "./config";
import type { IncomingWhatsAppMessage } from "./whatsapp";

// Orchestrates "finish out Bill Pay" — Phase 4's automatic invoice intake
// via WhatsApp (see docs/VISION.md: "invoice intake (email/upload/WhatsApp)").
// Seni forwards a photo or PDF of a bill to the same WhatsApp number he
// already uses to approve guest replies; this reads it, matches/creates the
// vendor, and drops a bill into the Bill Pay queue as pending_review. Never
// approves or pays anything — see billPay.ts's header comment.

const AGENT_KEY = "bill_pay";
const AGENT_NAME = "AI Bill Pay & Accounts Payable Manager";

/** Handles one inbound image/document message from Seni's WhatsApp. Always
 * resolves (never throws) — any failure gets reported back to Seni via
 * WhatsApp text and logged, rather than left silent or crashing the
 * webhook's message loop. */
export async function handleBillForward(
  msg: Extract<IncomingWhatsAppMessage, { type: "image" } | { type: "document" }>
): Promise<void> {
  if (!isAiReplyConfigured()) {
    await reply(
      "Got your file, but bill-reading isn't set up yet (missing ANTHROPIC_API_KEY) — add it in the Bill Pay tab manually for now."
    ).catch(() => {});
    return;
  }

  try {
    const { bytes, mimeType } = await downloadWhatsAppMedia(msg.mediaId);
    const extracted = await extractBillFromMedia({ bytes, mimeType });

    if (extracted.confidence === "low" || !extracted.vendorName || extracted.amount === null) {
      await reply(
        `Couldn't read that clearly enough to log automatically${extracted.notes ? ` (${extracted.notes})` : ""} — add it in the Bill Pay tab manually, or try a clearer photo.`
      ).catch(() => {});
      await logAiActivity({
        agentKey: AGENT_KEY,
        agentDisplayName: AGENT_NAME,
        task: "Extract bill from WhatsApp forward",
        trigger: `Seni forwarded a ${msg.type} via WhatsApp`,
        dataReviewed: extracted,
        decision: "extraction confidence too low to create a bill automatically",
        result: "skipped",
      }).catch(() => {});
      return;
    }

    const { vendor, created: vendorCreated } = await findOrCreateVendorByName(extracted.vendorName);

    const bill = await createBill({
      vendorId: vendor.id,
      amountCents: Math.round(extracted.amount * 100),
      currency: extracted.currency,
      invoiceNumber: extracted.invoiceNumber ?? undefined,
      category: extracted.category ?? undefined,
      invoiceDate: extracted.invoiceDate ?? undefined,
      dueDate: extracted.dueDate ?? undefined,
      source: "whatsapp",
      sourceReference: msg.mediaId,
    });

    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Extract bill from WhatsApp forward",
      trigger: `Seni forwarded a ${msg.type} via WhatsApp`,
      dataReviewed: extracted,
      decision: `extracted ${vendor.name}, ${extracted.currency} ${extracted.amount.toFixed(2)}${vendorCreated ? " (new vendor auto-created)" : ""}`,
      actionTaken: `Created bill ${bill.id}, status ${bill.status}`,
      confidenceScore: extracted.confidence === "high" ? 0.9 : 0.6,
      result: bill.status,
    }).catch(() => {});

    const amountText = `${extracted.currency} ${extracted.amount.toFixed(2)}`;
    const statusNote =
      bill.status === "flagged_duplicate"
        ? " — flagged as a possible duplicate, check Bill Pay."
        : " — added to Bill Pay as pending review.";
    const vendorNote = vendorCreated ? ` (new vendor "${vendor.name}" created — double-check the name)` : "";
    const uncertainNote = extracted.confidence === "medium" ? " Double-check the amount/details before approving." : "";

    await reply(
      `Got it — ${amountText} from ${vendor.name}${vendorNote}${statusNote}${uncertainNote}`
    ).catch(() => {});
  } catch (err) {
    const message =
      err instanceof WhatsAppError || err instanceof BillExtractError || err instanceof Error
        ? err.message
        : "Unknown error.";
    await reply(`That file didn't process: ${message.slice(0, 200)} — try again or enter it manually.`).catch(
      () => {}
    );
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Extract bill from WhatsApp forward",
      trigger: `Seni forwarded a ${msg.type} via WhatsApp`,
      error: message,
      result: "failed",
    }).catch(() => {});
  }
}
