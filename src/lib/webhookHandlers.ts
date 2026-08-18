import {
  sendAdminReplyNotificationTemplate,
  sendBookingNotificationTemplate,
  sendGuestReplyApprovalTemplate,
  sendWhatsAppText,
} from "@/lib/whatsapp";
import { config } from "@/lib/config";
import { draftGuestReply, type DraftedReply } from "@/lib/aiReply";
import { detectLanguageAndTranslateToEnglish, translateText } from "@/lib/translate";
import { wasCrmSentReply, alreadyNotifiedAdminReply } from "@/lib/adminReplyMarkers";
import { getGlobalHostStyleExamples } from "@/lib/inbox";
import { createPendingDraft, getPendingDraftByThreadId, linkWhatsAppMessageId } from "@/lib/pendingDrafts";
import { logAiActivity } from "@/lib/aiActivity";
import { getBookings, getTargetProperties } from "@/lib/ownerrez";
import type { Booking } from "@/lib/types";

// Handlers for the public /api/webhook endpoint (OwnerRez-style events).
// Payload shapes are deliberately parsed defensively: OwnerRez's webhook
// payloads use snake_case (entity_id, thread_id...) while this app's own
// types are camelCase, and the exact fields present vary by event type — so
// every field read below tolerates both spellings and missing values rather
// than trusting one exact schema. Nothing here throws to the caller: the
// route must always return 200 quickly (OwnerRez retries otherwise), so each
// handler catches and logs its own failures.
//
// NOTE: the 1-minute check-messages cron (api/cron/check-messages) remains
// the primary, proven pipeline for guest-message → AI draft → WhatsApp
// approval. This webhook path is an additional, faster trigger for the same
// flow — both share lib/pendingDrafts.ts's per-thread dedupe/supersede logic,
// so whichever fires first wins and the other skips.
// Official OwnerRez webhook payload (per their api-webhooks doc, confirmed
// 2026-08-15): { id, user_id, action: "entity_create"|"entity_update"|
// "entity_delete"|"webhook_test"|"application_authorization_revoked",
// entity_type: "booking"|"guest"|"inquiry"|"property"|"quote"|
// "thread_message"|"api_application", entity_id, categories: string[],
// entity: {...the record as the API would return it...} }.
// The extra message/booking/inquiry/data fields are tolerated for manual
// test POSTs that use a looser shape.
export interface OwnerRezWebhookEvent {
  id?: string | number;
  user_id?: number;
  eventType?: string;
  action?: string;
  entityType?: string;
  entity_type?: string;
  entityId?: string | number;
  entity_id?: string | number;
  categories?: string[];
  timestamp?: string;
  entity?: Record<string, unknown>;
  data?: Record<string, unknown>;
  message?: Record<string, unknown>;
  booking?: Record<string, unknown>;
  guest?: Record<string, unknown>;
  inquiry?: Record<string, unknown>;
  [key: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "TBD" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// --- Property scoping (Seni's explicit requirement, 2026-08-15) ---
// This OwnerRez account manages 8 properties, but WhatsApp pings must fire
// ONLY for the two that belong to this dashboard: "Legacy Colombia: Luxury
// Waterfront Wellness Retreat" (413494) and "Nukak - Casa #19" (492014).
// The account-wide webhook subscription fires for every property, so each
// handler filters here. getTargetProperties() is already scoped to exactly
// those two (and Redis-fallback-protected); getBookings() likewise, so
// "threadId appears in an allowed booking's threadIds" is the thread-level
// membership test. When scope can't be verified (OwnerRez hiccup, unknown
// thread), we SKIP the ping — the 1-minute property-scoped cron is the
// backstop, and a missed webhook ping beats paging Seni for someone else's
// property.
async function allowedPropertyIds(): Promise<Set<number> | null> {
  try {
    const props = await getTargetProperties();
    const ids = props.map((p) => p.id).filter((n): n is number => Number.isFinite(n));
    return ids.length > 0 ? new Set(ids) : null;
  } catch (err) {
    console.error("[webhookHandlers] getTargetProperties failed — can't verify property scope:", err);
    return null;
  }
}

/** true = allowed, false = another property's thread, null = unverifiable */
async function isThreadForAllowedProperty(threadId: number): Promise<boolean | null> {
  try {
    const bookings = await getBookings();
    return bookings.some((b) => Array.isArray(b.threadIds) && b.threadIds.includes(threadId));
  } catch (err) {
    console.error("[webhookHandlers] getBookings failed — can't verify thread scope:", err);
    return null;
  }
}

/** "created"-ish actions across OwnerRez's possible verb spellings. */
function isCreateAction(event: OwnerRezWebhookEvent): boolean {
  const action = (str(event.eventType) ?? str(event.action) ?? "").toLowerCase();
  if (!action) return true; // unknown shape — err toward notifying rather than silently dropping
  return ["created", "create", "new", "insert", "entity_create", "entity_insert"].includes(action);
}

/**
 * Guest message → AI draft → WhatsApp approval (YES/NO/EDIT:), reusing the
 * exact same pending-draft store + approval webhook the cron pipeline uses.
 * Host-authored messages instead notify Seni that his reply went out.
 */
export async function handleOwnerRezMessageEvent(event: OwnerRezWebhookEvent) {
  try {
    // Official payloads carry the record in `entity`; older/manual test
    // POSTs may use `message`/`data`. REAL field shape confirmed 2026-08-16
    // by fetching a live message entity (GET /v2/messages/{id}): body,
    // date_utc, from_contact_id, from_role, id, is_draft, and a NESTED
    // thread object { id, booking_id, property_id, quote_id, channel, type }
    // — there is NO top-level thread_id, which is why real events were
    // skipped as "missing threadId/body" until this fix.
    const m = (event.entity ?? event.message ?? event.data ?? {}) as Record<string, unknown>;
    const thread = (m.thread ?? {}) as Record<string, unknown>;

    // OwnerRez fires webhooks for UNSENT drafts too (is_draft: true — e.g.
    // a reply Seni is still composing in OwnerRez's UI). Never act on those.
    if (m.is_draft === true) return;

    const threadId = num(m.threadId ?? m.thread_id) ?? num(thread.id);
    const body = str(m.body ?? m.text ?? m.message);
    if (!threadId || !body) {
      console.warn("[webhookHandlers] Message event missing threadId/body — skipping", {
        entityId: event.entityId ?? event.entity_id,
      });
      return;
    }

    // Property scope check FIRST — before any branch that could ping Seni.
    // Real payloads carry it at thread.property_id (confirmed 2026-08-16).
    const messagePropId = num(m.property_id ?? m.propertyId) ?? num(thread.property_id);
    if (messagePropId !== undefined) {
      const allowed = await allowedPropertyIds();
      if (!allowed || !allowed.has(messagePropId)) {
        console.log(`[webhookHandlers] Message on thread ${threadId} is for property ${messagePropId} — outside this dashboard's scope, skipping`);
        return;
      }
    } else {
      const inScope = await isThreadForAllowedProperty(threadId);
      if (inScope !== true) {
        console.log(
          `[webhookHandlers] Thread ${threadId} ${inScope === false ? "belongs to another property" : "can't be property-verified"} — skipping (cron is the backstop)`
        );
        return;
      }
    }

    // let, not const (2026-08-18): real OwnerRez message payloads carry no
    // guest name, so this starts as "Guest" — the booking lookup further down
    // upgrades it to the real name for the approval alert.
    let guestName = str(m.guestName ?? m.guest_name) ?? "Guest";
    const fromRole = (str(m.fromRole ?? m.from_role ?? m.senderType ?? m.sender_type) ?? "").toLowerCase();
    const isGuestMessage = m.isGuest === true || m.is_guest === true || fromRole === "guest";
    const isHostMessage = ["admin", "owner", "host", "co_host", "cohost"].includes(fromRole);

    if (isHostMessage && !isGuestMessage) {
      // Another admin (or automation) replied to the guest in OwnerRez —
      // surface it on Seni's WhatsApp (2026-08-18, Seni's ask: other admins
      // reply directly in OwnerRez and he needs to see those too).
      //
      // Skip the CRM's own sends (approval YES / dashboard replies / EDIT:) —
      // those flows are Seni's own actions and re-pinging every one of them
      // would bury the genuinely-new co-admin activity this exists to show.
      if (await wasCrmSentReply(body).catch(() => false)) return;
      // Content dedupe vs the check-messages cron's admin-reply sweep, which
      // observes the same message a minute later.
      if (await alreadyNotifiedAdminReply(body).catch(() => false)) return;

      // English reading for Seni — co-admins (Gabriel) often reply in
      // Spanish, and Seni only reads English. Degrades to the original text.
      let adminReplyEnglish = body;
      let translatedNote = "";
      const det = await detectLanguageAndTranslateToEnglish(body).catch(() => null);
      if (det && det.language !== "English" && det.english.trim()) {
        adminReplyEnglish = det.english.trim();
        translatedNote = ` [translated from ${det.language}]`;
      }
      try {
        await sendAdminReplyNotificationTemplate({
          guestName,
          guestMessage: "(see OwnerRez thread)",
          adminReply: adminReplyEnglish.slice(0, 350),
        });
      } catch {
        await sendWhatsAppText(
          `✅ An admin replied to ${guestName} via OwnerRez (thread #${threadId})${translatedNote}:\n\n"${adminReplyEnglish.slice(0, 300)}"`
        ).catch(() => {});
      }
      return;
    }

    if (!isGuestMessage) return; // system/unknown-role message — nothing to do

    console.log(`[webhookHandlers] Guest message on thread ${threadId} from ${guestName}`);

    // Same dedupe rule as the cron: one pending draft per thread. A still-
    // pending draft means Seni hasn't decided yet — don't re-page him.
    // (createPendingDraft below auto-supersedes if we do proceed.)
    const existing = await getPendingDraftByThreadId(threadId).catch(() => null);
    // Only dedupe when the existing draft was actually TEXTED to Seni
    // (wamid present). A pending draft with no wamid means the WhatsApp
    // send failed after creation (seen 2026-08-16: stale env phone-number
    // id during the DB outage) — fall through so the supersede path
    // recreates it and retries the send.
    if (existing && existing.status === "pending" && existing.guestMessage === body && existing.wamid) {
      console.log(`[webhookHandlers] Draft ${existing.id} already pending for this exact message — skipping`);
      return;
    }

    // Draft a reply with Claude. Non-fatal on failure — Seni can still
    // answer with "EDIT: <his own text>".
    //
    // REWORKED 2026-08-17 (audit): this used to call chatWidget.ts's
    // draftEscalationAnswerForApproval — the ASSUMPTIVE prompt built for
    // anonymous website visitors, which is explicitly allowed to invent
    // pricing ballparks and scheduling guesses because "Seni will fix or
    // reject anything off-base". Using it for a REAL booked guest's message
    // meant (a) invented prices one distracted YES away from a paying
    // guest, (b) `language` hard-defaulted to "English" so a Spanish
    // guest's approved reply went out untranslated, and (c) service
    // requests never set isServiceRequest, so the Gabriel flow never
    // triggered from this path. Now it uses the same draftGuestReply()
    // pipeline as the check-messages cron: booking context when the thread
    // maps to a known booking (a synthesized minimal context otherwise —
    // draftGuestReply treats unknown arrival/departure as "unknown" and its
    // prompt forbids inventing prices/codes/availability either way),
    // Seni's account-wide style pool, and real language detection with
    // English previews for the approval text.
    let drafted: DraftedReply | undefined;
    let detectedLanguage = "English";
    let guestMessageEnglish: string | undefined;
    try {
      // The thread's booking gives the drafting prompt its guest name,
      // arrival/departure (which also gates sharing the exact address), and
      // property. getBookings() is the same short-cache call the scope check
      // above may already have made, so this is cheap. A webhook can fire
      // for a thread not yet visible in the bookings list (brand-new
      // booking, OwnerRez sync lag) — synthesize a minimal context then
      // rather than falling back to the assumptive visitor prompt.
      const bookingList = await getBookings().catch(() => [] as Booking[]);
      const booking: Booking =
        bookingList.find((b) => Array.isArray(b.threadIds) && b.threadIds.includes(threadId)) ?? {
          id: num(m.bookingId ?? m.booking_id) ?? num(thread.booking_id) ?? 0,
          propertyId: messagePropId ?? 0,
          guestId: num(m.guestId ?? m.guest_id) ?? null,
          guestName,
          arrival: "", // draftGuestReply renders "" as "unknown" — the address gate then stays shut
          departure: "",
          nights: 0,
          status: "Unknown",
          source: "OwnerRez",
          adults: 0,
          children: 0,
          totalAmount: 0,
          isBlock: false,
          threadIds: [threadId],
        };

      // Upgrade the placeholder "Guest" to the booking's real guest name so
      // the WhatsApp alert reads "New message from María…" not "from Guest"
      // (2026-08-18, Seni's report — his alert literally said "Guest").
      if (booking.guestName?.trim()) guestName = booking.guestName.trim();

      // Same account-wide host-voice corpus the cron/Inbox use (600s cache
      // in lib/inbox.ts, so this is usually a warm read). Failure just means
      // the prompt's built-in "no past host messages found" default tone.
      const stylePool = await getGlobalHostStyleExamples(12).catch(() => [] as string[]);

      drafted = await draftGuestReply({
        guestMessage: body,
        booking,
        hostMessages: stylePool.map((styleBody) => ({
          id: 0,
          threadId,
          body: styleBody,
          isGuest: false,
          fromRole: "co_host",
        })),
      });
      detectedLanguage = drafted.language;
      guestMessageEnglish = drafted.guestMessageEnglish;
    } catch (draftError) {
      console.error("[webhookHandlers] AI draft failed:", draftError);
      // Even with no draft, still detect the guest's real language (instead
      // of the old hard "English" default) so Seni's eventual "EDIT: <his
      // English text>" gets translated back before it reaches the guest,
      // and so his alert shows an English reading of the message. Degrades
      // to English + original text on any failure.
      const detected = await detectLanguageAndTranslateToEnglish(body).catch(() => null);
      if (detected) {
        detectedLanguage = detected.language;
        guestMessageEnglish = detected.language !== "English" ? detected.english : undefined;
      }
    }

    // FINAL ENGLISH GUARANTEE (2026-08-18 — Seni received this path's alert
    // fully in Spanish: "Si gracias, todo bien" + a Spanish suggested reply).
    // Root cause: this path trusted the drafting model's SELF-REPORTED
    // language + translation fields. When the model mislabels a short message
    // as English (or returns "" so the parser falls back to the original
    // text), no translation ever happened and no other layer re-checked.
    // Never trust the drafting call here: if the "English" preview we hold is
    // just the original text, run an INDEPENDENT detection over the guest's
    // message; if that says non-English, translate both sides for the alert.
    // In the normal case (model translated properly) this costs nothing — the
    // previews already differ from the originals and both checks short-circuit.
    let replyEnglish = drafted?.replyEnglish;
    if (!guestMessageEnglish || guestMessageEnglish === body) {
      const det = await detectLanguageAndTranslateToEnglish(body).catch(() => null);
      if (det && det.language !== "English" && det.english.trim()) {
        guestMessageEnglish = det.english.trim();
        detectedLanguage = det.language;
      }
    }
    if (drafted && detectedLanguage !== "English" && (!replyEnglish || replyEnglish === drafted.reply)) {
      const t = await translateText(drafted.reply, "en").catch(() => null);
      if (t?.ok && t.text.trim()) replyEnglish = t.text.trim();
    }

    const pending = await createPendingDraft({
      threadId,
      bookingId: num(m.bookingId ?? m.booking_id) ?? num(thread.booking_id) ?? 0,
      guestId: num(m.guestId ?? m.guest_id) ?? null,
      guestName,
      guestMessage: body,
      draftReply: drafted?.reply ?? "",
      // English previews for Seni's approval view — independently verified
      // above, so the language stored here is what the EDIT: path will
      // translate Seni's English back into.
      replyEnglish,
      guestMessageEnglish,
      language: detectedLanguage,
      isServiceRequest: drafted?.isServiceRequest ?? false,
    });

    // Approval text shows Seni the ENGLISH readings (he only reads English);
    // the native-language drafted.reply is what actually goes to the guest
    // on YES — same convention as the check-messages cron's alert.
    const alertGuestMessage = guestMessageEnglish ?? body;
    const alertReply = drafted ? replyEnglish || drafted.reply : undefined;
    const languageNote = detectedLanguage !== "English" ? ` [written in ${detectedLanguage}]` : "";
    const draftLine = alertReply
      ? `Suggested reply${languageNote}:\n"${alertReply}"\n\nReply YES to send it, NO to skip, or "EDIT: <your text>" to send your own wording.`
      : `No suggested reply could be drafted — reply "EDIT: <your text>" to send an answer, or NO to skip.`;
    const approvalText = `New message from ${guestName} (thread #${threadId}):\n\n"${alertGuestMessage}"\n\n${draftLine}`;

    // Template first (delivers regardless of the 24h session window — the
    // exact silent-failure class that plagued this feature), free text as
    // the fallback if the template errors for any reason.
    let approvalWamid: string | undefined;
    try {
      approvalWamid = await sendGuestReplyApprovalTemplate({
        guestName,
        propertyName: config.propertyName || "Legacy Colombia",
        guestMessage: alertGuestMessage,
        suggestedReply: alertReply ?? "N/A",
      });
    } catch {
      approvalWamid = await sendWhatsAppText(approvalText).catch(() => undefined);
    }

    // Link the WhatsApp message id so a swipe-reply on that exact approval
    // message resolves to this draft (same as the cron pipeline does).
    if (approvalWamid) {
      await linkWhatsAppMessageId(pending.id, approvalWamid).catch(() => {});
    }

    await logAiActivity({
      agentKey: "guest_experience",
      agentDisplayName: "AI Guest Experience Manager",
      task: "Draft reply to guest message (webhook)",
      trigger: `Guest message from ${guestName} on thread #${threadId}: "${body.slice(0, 200)}"`,
      decision: drafted ? "drafted reply, awaiting owner approval" : "no draft — awaiting owner's own wording",
      actionTaken: approvalWamid
        ? "Sent approval request to Seni via WhatsApp; awaiting YES/NO/EDIT response"
        : "Created pending draft, but the WhatsApp approval send failed — visible in the dashboard Approvals tab",
      result: "pending",
    }).catch(() => {});
  } catch (error) {
    console.error("[webhookHandlers] Error processing message event:", error);
  }
}

/** New booking → WhatsApp notification (template first, free text fallback). */
export async function handleOwnerRezBookingEvent(event: OwnerRezWebhookEvent) {
  try {
    if (!isCreateAction(event)) return; // updates/cancellations would be noisy

    const b = (event.entity ?? event.booking ?? event.data ?? {}) as Record<string, unknown>;
    // Calendar blocks / channel-sync holds aren't real bookings — no ping.
    if (b.is_block === true || b.isBlock === true || String(b.type ?? "") === "block") return;

    // Property scope: only Legacy Colombia + Nukak Casa #19 may ping.
    const bookingPropId = num(b.property_id ?? b.propertyId) ?? num((b.property as Record<string, unknown> | undefined)?.id);
    if (bookingPropId === undefined) {
      console.warn("[webhookHandlers] Booking event has no property id — skipping ping (strict 2-property scope)");
      return;
    }
    const allowed = await allowedPropertyIds();
    if (!allowed || !allowed.has(bookingPropId)) {
      console.log(`[webhookHandlers] Booking for property ${bookingPropId} — outside this dashboard's scope, skipping`);
      return;
    }
    const guestName = str(b.guestName ?? b.guest_name ?? b.fullName ?? b.full_name) ?? "Guest";
    const arrival = str(b.arrival ?? b.checkIn ?? b.check_in ?? b.arrival_date);
    const departure = str(b.departure ?? b.checkOut ?? b.check_out ?? b.departure_date);
    const nights = num(b.nights);
    const propertyName = str(b.propertyName ?? b.property_name) ?? config.propertyName ?? "Legacy Colombia";
    // Total the guest paid (Seni's ask, 2026-08-15). OwnerRez booking
    // entities carry total_amount; folded into the template's dates param
    // (free text, so no Meta re-review needed) and the fallback text alike.
    const totalAmount = num(b.total_amount ?? b.totalAmount);
    const totalPart =
      totalAmount !== undefined && totalAmount > 0
        ? ` • $${totalAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} total`
        : "";
    const dates = `${fmtDate(arrival)} → ${fmtDate(departure)}${nights ? ` (${nights} night${nights === 1 ? "" : "s"})` : ""}${totalPart}`;

    try {
      await sendBookingNotificationTemplate({ guestName, propertyName, dates });
    } catch {
      await sendWhatsAppText(
        `🎉 *New booking!*\n\nGuest: ${guestName}\nProperty: ${propertyName}\nDates: ${dates}${
          totalAmount !== undefined && totalAmount > 0
            ? `\nTotal paid: $${totalAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
            : ""
        }\n\nSee OwnerRez for full details.`
      ).catch(() => {});
    }
    console.log(`[webhookHandlers] Booking notification sent for ${guestName}`);
  } catch (error) {
    console.error("[webhookHandlers] Error processing booking event:", error);
  }
}

/** Guest profile events — no notification needed, log only. */
export async function handleOwnerRezGuestEvent(event: OwnerRezWebhookEvent) {
  console.log("[webhookHandlers] Guest event received", {
    eventType: event.eventType ?? event.action,
    entityId: event.entityId ?? event.entity_id,
  });
}

/** New pre-booking inquiry → WhatsApp heads-up to Seni. */
export async function handleOwnerRezInquiryEvent(event: OwnerRezWebhookEvent) {
  try {
    if (!isCreateAction(event)) return;

    const inq = (event.entity ?? event.inquiry ?? event.data ?? {}) as Record<string, unknown>;

    // Property scope: only Legacy Colombia + Nukak Casa #19 may ping.
    const inqPropId = num(inq.property_id ?? inq.propertyId) ?? num((inq.property as Record<string, unknown> | undefined)?.id);
    if (inqPropId === undefined) {
      console.warn("[webhookHandlers] Inquiry event has no property id — skipping ping (strict 2-property scope)");
      return;
    }
    const allowed = await allowedPropertyIds();
    if (!allowed || !allowed.has(inqPropId)) {
      console.log(`[webhookHandlers] Inquiry for property ${inqPropId} — outside this dashboard's scope, skipping`);
      return;
    }

    const guestName = str(inq.guestName ?? inq.guest_name ?? inq.name) ?? "Guest";
    const question = str(inq.message ?? inq.question ?? inq.body) ?? "(no message provided)";

    await sendWhatsAppText(
      `❓ *New guest inquiry*\n\nFrom: ${guestName}\n\n"${question.slice(0, 400)}"\n\nCheck OwnerRez to respond.`
    ).catch(() => {});
    console.log(`[webhookHandlers] Inquiry notification sent for ${guestName}`);
  } catch (error) {
    console.error("[webhookHandlers] Error processing inquiry event:", error);
  }
}
