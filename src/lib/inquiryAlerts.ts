// Inquiry alert POLLING — the guaranteed path (2026-08-21, Seni: "I did not
// receive the inquiry and message from Juan Botero from this morning. Please
// fix with 100% certainty!").
//
// Why this exists: inquiry alerts previously had exactly ONE delivery path —
// the OwnerRez `inquiry` webhook (webhookHandlers.handleOwnerRezInquiryEvent).
// OwnerRez has now silently killed webhook deliveries THREE times while still
// listing the subscriptions as active (2026-08-18 pre-Shlomo, again before
// Juan Botero's 2026-08-21 inquiry) — and it never redelivers missed events
// after a resubscribe, so every death loses whatever arrived in the blind
// window. Unlike guest MESSAGES (which the every-minute check-messages cron
// polls independently of webhooks), inquiries have no booking/thread, so no
// existing poll ever saw them.
//
// This module closes that hole with a PULL loop: every check-messages run
// (once a minute) lists inquiries created in the last LOOKBACK_HOURS straight
// from the OwnerRez API and alerts on any not yet seen. Polling cannot
// silently die the way push can — if OwnerRez's API is down, the cron run
// errors loudly instead of nothing happening. The webhook path stays as the
// faster trigger; both paths share the same Redis seen-key so whichever
// fires first wins and the other skips (same convention as pendingDrafts'
// webhook/cron dedupe).
//
// Seen-key is only written AFTER a successful WhatsApp send (template or
// free-text fallback), so a Meta hiccup retries next minute instead of
// silently losing the alert — same rule as balanceDueAlerts.ts.
import { redisGet, redisSet } from "@/lib/redis";
import { getGuestById, getRecentInquiries, type OwnerRezInquiry } from "@/lib/ownerrez";
import { sendNewInquiryTemplate, sendWhatsAppText } from "@/lib/whatsapp";
import { logAiActivity } from "@/lib/aiActivity";

const AGENT_KEY = "guest_experience";
const AGENT_NAME = "AI Guest Experience Manager";

// How far back each poll looks. Long enough that a multi-hour outage
// (OwnerRez API down, deploy gap, Vercel incident) can't out-wait the
// window; the seen-keys keep re-polls of the same inquiry silent.
const LOOKBACK_HOURS = 48;

// Well past the lookback window — an inquiry can never fall out of the
// seen-set while still being re-fetchable by the poll.
const SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export function inquirySeenKey(orgId: string, inquiryId: number | string): string {
  return `inquiry-alert:${orgId}:${inquiryId}`;
}

/** Marks an inquiry as already-alerted — exported so the webhook path
 * (webhookHandlers.handleOwnerRezInquiryEvent) writes the same key after ITS
 * successful send, keeping the two paths mutually deduped. */
export async function markInquiryAlerted(orgId: string, inquiryId: number | string): Promise<void> {
  await redisSet(inquirySeenKey(orgId, inquiryId), "1", { exSeconds: SEEN_TTL_SECONDS });
}

export async function wasInquiryAlerted(orgId: string, inquiryId: number | string): Promise<boolean> {
  return Boolean(await redisGet(inquirySeenKey(orgId, inquiryId)));
}

export async function pollInquiryAlerts(orgId: string): Promise<{
  fetched: number;
  alerted: { id: number; guestName: string | null }[];
  errors: { id: number; error: string }[];
}> {
  const sinceUtc = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const inquiries: OwnerRezInquiry[] = await getRecentInquiries(sinceUtc, orgId);

  const alerted: { id: number; guestName: string | null }[] = [];
  const errors: { id: number; error: string }[] = [];

  for (const inq of inquiries) {
    if (!inq.id) continue; // no stable id — can't dedupe safely, skip rather than risk a re-alert loop
    try {
      if (await wasInquiryAlerted(orgId, inq.id)) continue;

      // OwnerRez inquiry records carry only a guest_id, no name (confirmed
      // live 2026-08-21 — rawKeys had guest_id but no name fields, so the
      // first alerts said just "Guest"). One extra lookup per NEW inquiry
      // (rare) puts the real name in the alert; failure degrades to "Guest".
      let guestName = inq.guestName ?? "";
      if (!guestName) {
        const guestId = Number((inq.raw as { guest_id?: unknown }).guest_id);
        if (guestId) {
          const guest = await getGuestById(guestId, orgId).catch(() => undefined);
          guestName = guest?.fullName?.trim() || "";
        }
      }
      if (!guestName) guestName = "Guest";
      const question = inq.message ?? "(no message provided)";

      // Same template-first/free-text-fallback ladder as the webhook path.
      let sent = false;
      let sendError: string | undefined;
      try {
        await sendNewInquiryTemplate({ guestName, question }, orgId);
        sent = true;
      } catch (tmplErr) {
        sendError = tmplErr instanceof Error ? tmplErr.message : String(tmplErr);
        try {
          await sendWhatsAppText(
            `❓ *New Inquiry*\n\nFrom: ${guestName}\n\n"${question.slice(0, 400)}"\n\nCheck OwnerRez to respond.`,
            orgId
          );
          sent = true;
        } catch (textErr) {
          sendError = textErr instanceof Error ? textErr.message : String(textErr);
        }
      }

      if (sent) {
        await markInquiryAlerted(orgId, inq.id);
        alerted.push({ id: inq.id, guestName });
      } else {
        errors.push({ id: inq.id, error: sendError ?? "Unknown send error." });
      }

      await logAiActivity(
        {
          agentKey: AGENT_KEY,
          agentDisplayName: AGENT_NAME,
          task: "Notify new inquiry (poll)",
          trigger: `Inquiry ${inq.id} from ${guestName} (created ${inq.createdUtc ?? "?"}): "${question.slice(0, 200)}"`,
          actionTaken: sent
            ? "Sent new-inquiry WhatsApp to Seni via the polling backstop"
            : "FAILED to deliver the new-inquiry WhatsApp (will retry next poll)",
          result: sent ? "notified" : "failed",
          error: sent ? undefined : sendError,
        },
        orgId
      ).catch(() => {});
    } catch (err) {
      errors.push({ id: inq.id, error: err instanceof Error ? err.message : "Unknown error." });
    }
  }

  return { fetched: inquiries.length, alerted, errors };
}
