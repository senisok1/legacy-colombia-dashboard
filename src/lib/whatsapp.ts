import { config } from "./config";
import { getDefaultOrganizationId } from "./organizations";
import { getWhatsAppCredentials, type WhatsAppCredentials } from "./credentials";

// Thin wrapper around Meta's WhatsApp Cloud API — sending and parsing
// incoming webhook payloads. Uses the WhatsApp Business Platform directly
// (no Twilio or other middleman), per Seni's explicit preference. Auth is
// the permanent System User access token set up in Meta Business Settings
// (see README's WhatsApp section) — a "Try it out" temporary token would
// expire every 24 hours, which doesn't work for an unattended cron job.

const GRAPH_API_VERSION = "v21.0";

export class WhatsAppError extends Error {}

// ---------- Phase 3: per-tenant credential resolution ----------
// Same pattern as lib/ownerrez.ts and lib/pricelabs.ts: every exported
// function below takes an OPTIONAL trailing organizationId, defaulting to
// the pre-existing single customer's org (byte-for-byte the same behavior
// as before this change). Fails soft to the global config.* values on any
// DB error.
//
// Note: the Meta-approved template names/language (service-request,
// chat-reply, vendor-notify, template language) stay read from global
// config directly, not per-org — those are tied to Seni's own WhatsApp
// Business Account and require Meta template approval, so they aren't part
// of getWhatsAppCredentials()'s per-tenant resolver bag yet. Same reasoning
// as lib/credentials.ts's getWhatsAppCredentials() comment.
async function resolveWhatsAppCredentials(organizationId?: string): Promise<WhatsAppCredentials> {
  const fallback: WhatsAppCredentials = {
    accessToken: config.whatsappAccessToken,
    phoneNumberId: config.whatsappPhoneNumberId,
    businessAccountId: config.whatsappBusinessAccountId,
    recipientNumber: config.whatsappRecipientNumber,
    verifyToken: config.whatsappVerifyToken,
    gabrielNumber: config.whatsappGabrielNumber,
  };
  try {
    const orgId = organizationId ?? (await getDefaultOrganizationId());
    return await getWhatsAppCredentials(orgId);
  } catch (err) {
    console.error("[whatsapp] Falling back to global config credentials:", err);
    return fallback;
  }
}

function isConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && creds.recipientNumber);
}

function isGabrielConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && creds.gabrielNumber && config.whatsappServiceRequestTemplate);
}

function isChatReplyConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && config.whatsappChatReplyTemplate);
}

function isVendorConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && config.whatsappVendorNotifyTemplate);
}

function isSessionOpenerConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && config.whatsappSessionOpenerTemplate);
}

function isGuestReplyApprovalConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && creds.recipientNumber && config.whatsappGuestReplyApprovalTemplate);
}

function isDailySummaryConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && creds.recipientNumber && config.whatsappDailySummaryTemplate);
}

function isBookingNotificationConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && creds.recipientNumber && config.whatsappBookingNotificationTemplate);
}

function isAdminReplyNotificationConfigured(creds: WhatsAppCredentials): boolean {
  return Boolean(creds.accessToken && creds.phoneNumberId && creds.recipientNumber && config.whatsappAdminReplyNotificationTemplate);
}

/** Shared POST to the Graph API messages endpoint — both plain-text sends
 * (to Seni) and template sends (to Gabriel) funnel through this. */
async function postWhatsAppMessage(payload: Record<string, unknown>, creds: WhatsAppCredentials): Promise<string> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new WhatsAppError(`WhatsApp send returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { messages?: { id?: string }[] };
  const wamid = data.messages?.[0]?.id;
  if (!wamid) throw new WhatsAppError("WhatsApp send succeeded but returned no message id.");
  return wamid;
}

/** ROOT CAUSE of "Meta returns 200 + wamid but nothing arrives" for
 * template sends, found 2026-08-15 via the delivery diagnostic route: most
 * of this account's templates were created as plain "English" (language
 * code "en") while config.whatsappTemplateLanguage defaults to "en_US" —
 * Meta rejects that send with error 132001 "Template name does not exist in
 * the translation", every caller's catch falls back to free text, and free
 * text silently never delivers outside the 24h customer-service window.
 * Net effect: weeks of missing approval pings. The account has a MIX of
 * language codes ("en" for guest_reply_approval_alert/daily_summary_alert/
 * admin_reply/booking_notification/chat_widget_reply, "en_US" for
 * service_request_alert and hello_world), so no single global language
 * setting can be right for all of them. This wrapper tries the configured
 * code first, then the other common English codes — retrying ONLY on the
 * template-language error, so real failures still surface immediately. */
/**
 * Meta rejects any template BODY PARAMETER containing a newline, a tab, or
 * more than four consecutive spaces — error 132018, "Param text cannot have
 * new-line/tab characters or more than 4 consecutive spaces".
 *
 * ROOT CAUSE, found 2026-08-17: real guest messages are multi-line ("Hola!\n
 * Quisiera saber…"), so every guest-reply approval alert containing one
 * failed with 132018. The caller caught that and fell back to
 * sendWhatsAppText(), which first sends a CONTENT-FREE session-opener
 * template (delivered fine — this is the stream of "automated notifications"
 * Seni was getting) and then the real free-text message, which failed with
 * 131047 whenever the 24h window was shut. Net effect: a burst of
 * meaningless pings, and the actual guest message plus its translation never
 * arrived. The diagnostic test send passed the whole time because its
 * sample text was a tidy single line.
 *
 * Collapsing whitespace here — at the single point where every template
 * parameter is built — is the durable fix. The full untruncated text is
 * always still in the CRM's Messaging/Approvals tabs; this only affects the
 * one-line alert.
 */
function templateParam(value: string | number | null | undefined, maxLength = 350): string {
  const text = value === null || value === undefined ? "" : String(value);
  const collapsed = text
    .replace(/[\r\n\t]+/g, " ") // newlines/tabs are hard-rejected by Meta
    .replace(/\s{2,}/g, " ") // ">4 consecutive spaces" — collapse them all
    .trim();
  return collapsed.slice(0, maxLength);
}

function isTemplateLanguageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("132001") || msg.includes("does not exist in");
}

async function postTemplateWithLanguageFallback(
  payload: Record<string, unknown>,
  creds: WhatsAppCredentials
): Promise<string> {
  const template = payload.template as { language?: { code?: string } } | undefined;
  const configured = template?.language?.code || config.whatsappTemplateLanguage || "en_US";
  const candidates = [...new Set([configured, "en", "en_US"])];
  let lastErr: unknown = new WhatsAppError("Template send failed in every language code tried.");
  for (const code of candidates) {
    try {
      return await postWhatsAppMessage(
        { ...payload, template: { ...(payload.template as Record<string, unknown>), language: { code } } },
        creds
      );
    } catch (err) {
      lastErr = err;
      if (!isTemplateLanguageError(err)) throw err;
      console.warn(`[whatsapp] template not available in "${code}" — trying next language code`);
    }
  }
  throw lastErr;
}

/**
 * Sends the zero-parameter WHATSAPP_SESSION_OPENER_TEMPLATE to Seni's own
 * number ahead of a free-text push — see the 2026-08-07 comment on
 * config.whatsappSessionOpenerTemplate for the full root-cause writeup.
 * A template message can reach Seni even if his 24h customer-service window
 * with this number has closed, and doing so reopens that window for the
 * free-text message sendWhatsAppText sends immediately after. Deliberately
 * swallows its own errors (template not configured, not yet approved by
 * Meta, transient failure) rather than throwing — this is a best-effort
 * reliability layer on top of the existing free-text send, not a
 * replacement for it, so a problem here should never block the actual
 * message from at least being attempted the old way.
 */
async function sendSessionOpener(creds: WhatsAppCredentials): Promise<void> {
  // DISABLED 2026-08-17. This fired a zero-content template — "This is an
  // automated notification from your Legacy Colombia CRM Dashboard. New
  // details follow in the next message." — before every free-text send, to
  // reopen the 24h window. Two problems, both seen live today:
  //   1. When the follow-up free text then failed with 131047 (window shut),
  //      Seni received ONLY the meaningless opener. That's exactly the
  //      "duplicate automated notifications" he reported: two openers landed,
  //      both of their real payloads were rejected.
  //   2. Every real alert now goes out as a proper Meta-approved TEMPLATE
  //      (guest replies, bookings, inquiries), which reaches him regardless
  //      of the window — so the opener buys nothing and costs a message.
  // Left as a no-op rather than deleted so the call sites stay honest about
  // the ordering constraint if free text is ever reinstated.
  return;
  // eslint-disable-next-line no-unreachable
  if (!isSessionOpenerConfigured(creds)) return;
  try {
    await postTemplateWithLanguageFallback(
      {
        messaging_product: "whatsapp",
        to: creds.recipientNumber,
        type: "template",
        template: {
          name: config.whatsappSessionOpenerTemplate,
          language: { code: config.whatsappTemplateLanguage },
        },
      },
      creds
    );
  } catch (err) {
    console.error("[whatsapp] Session-opener template send failed (non-fatal):", err);
  }
}

/**
 * Sends a plain text WhatsApp message to Seni's own number (the only
 * recipient this app is configured to message via free text — see
 * WHATSAPP_RECIPIENT_NUMBER). Returns the WhatsApp message id (wamid) so
 * callers can link a specific approval-request message to the pending draft
 * it's about, letting Seni swipe-to-reply on WhatsApp to disambiguate which
 * draft he's approving.
 *
 * ALWAYS preceded by sendSessionOpener() — see that function's comment and
 * the 2026-08-07 root-cause writeup on config.whatsappSessionOpenerTemplate.
 * Without this, a closed 24h session makes THIS call return a real wamid
 * from Meta while the message is silently never delivered — indistinguishable
 * from success at every layer of this app.
 */
export async function sendWhatsAppText(text: string, organizationId?: string): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isConfigured(creds)) {
    throw new WhatsAppError("WhatsApp isn't configured — missing access token, phone number id, or recipient.");
  }

  await sendSessionOpener(creds);

  return postWhatsAppMessage(
    {
      messaging_product: "whatsapp",
      to: creds.recipientNumber,
      type: "text",
      text: { body: text, preview_url: false },
    },
    creds
  );
}

/**
 * Sends the per-message guest-reply approval ping to Seni as a real
 * Meta-approved Utility template — the actual durable fix for the
 * session-window bug (see config.whatsappGuestReplyApprovalTemplate's
 * comment for why the earlier crm_session_opener approach didn't really
 * work). A template can reach Seni whether or not his 24h window with this
 * number is open, unlike sendWhatsAppText's plain free text. Truncates the
 * guest message/suggested reply to keep the combined template body under
 * Meta's 1024-character cap (same margin used by the other body-param
 * templates in this file) — the full untruncated text is always available
 * in the CRM's Approvals/Messaging tabs, this is just the alert.
 *
 * Throws WhatsAppError if not configured/approved yet — callers should catch
 * this and fall back to sendWhatsAppText (see check-messages/route.ts) so a
 * pending Meta review never blocks the alert outright.
 */
export async function sendGuestReplyApprovalTemplate(
  params: { guestName: string; propertyName: string; guestMessage: string; suggestedReply: string },
  organizationId?: string
): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isGuestReplyApprovalConfigured(creds)) {
    throw new WhatsAppError("Guest-reply approval template isn't configured/approved yet.");
  }

  return postTemplateWithLanguageFallback(
    {
      messaging_product: "whatsapp",
      to: creds.recipientNumber,
      type: "template",
      template: {
        name: config.whatsappGuestReplyApprovalTemplate,
        language: { code: config.whatsappTemplateLanguage },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: templateParam(params.guestName.slice(0, 60) || "Guest") },
              { type: "text", text: templateParam(params.propertyName.slice(0, 60) || "your property") },
              { type: "text", text: templateParam(params.guestMessage.slice(0, 350)) },
              { type: "text", text: templateParam(params.suggestedReply.slice(0, 350)) },
            ],
          },
        ],
      },
    },
    creds
  );
}

/**
 * Sends the daily executive-report ping to Seni as a real Meta-approved
 * Utility template — same durable-delivery reasoning as
 * sendGuestReplyApprovalTemplate above. Deliberately short: the full report
 * (every metric, the AI COO narrative, everything) still goes out over email
 * via Resend (see lib/executiveReport.ts), which has no session-window
 * concept at all — this template is just a guaranteed-to-arrive headline
 * that points back to the full report, not a replacement for it. Throws
 * WhatsAppError if not configured/approved yet — see
 * executiveReport.ts's fallback to the old sendWhatsAppText behavior.
 */
export async function sendDailySummaryTemplate(
  params: { orgLabel: string; headline: string; statsLine: string },
  organizationId?: string
): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isDailySummaryConfigured(creds)) {
    throw new WhatsAppError("Daily summary template isn't configured/approved yet.");
  }

  return postTemplateWithLanguageFallback(
    {
      messaging_product: "whatsapp",
      to: creds.recipientNumber,
      type: "template",
      template: {
        name: config.whatsappDailySummaryTemplate,
        language: { code: config.whatsappTemplateLanguage },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: templateParam(params.orgLabel.slice(0, 60) || "your property") },
              { type: "text", text: templateParam(params.headline.slice(0, 300)) },
              { type: "text", text: templateParam(params.statsLine.slice(0, 300)) },
            ],
          },
        ],
      },
    },
    creds
  );
}

/**
 * Sends a booking confirmation template to Seni's own number with guest name,
 * property name, and booking dates. Uses Meta-approved template for guaranteed
 * delivery independent of the 24-hour customer-service window.
 */
export async function sendBookingNotificationTemplate(
  params: { guestName: string; propertyName: string; dates: string },
  organizationId?: string
): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isBookingNotificationConfigured(creds)) {
    throw new WhatsAppError("Booking notification template isn't configured/approved yet.");
  }

  return postTemplateWithLanguageFallback(
    {
      messaging_product: "whatsapp",
      to: creds.recipientNumber,
      type: "template",
      template: {
        name: config.whatsappBookingNotificationTemplate,
        language: { code: config.whatsappTemplateLanguage },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: templateParam(params.guestName.slice(0, 60) || "Guest") },
              { type: "text", text: templateParam(params.propertyName.slice(0, 60) || "your property") },
              { type: "text", text: templateParam(params.dates.slice(0, 100)) },
            ],
          },
        ],
      },
    },
    creds
  );
}

/**
 * Sends an admin reply notification template to Seni's own number when admin
 * needs to reply to a guest inquiry. Includes guest name, guest message, and
 * admin's reply. Uses Meta-approved template for guaranteed delivery independent
 * of the 24-hour customer-service window.
 */
export async function sendAdminReplyNotificationTemplate(
  params: { guestName: string; guestMessage: string; adminReply: string },
  organizationId?: string
): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isAdminReplyNotificationConfigured(creds)) {
    throw new WhatsAppError("Admin reply notification template isn't configured/approved yet.");
  }

  return postTemplateWithLanguageFallback(
    {
      messaging_product: "whatsapp",
      to: creds.recipientNumber,
      type: "template",
      template: {
        name: config.whatsappAdminReplyNotificationTemplate,
        language: { code: config.whatsappTemplateLanguage },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: templateParam(params.guestName.slice(0, 60) || "Guest") },
              { type: "text", text: templateParam(params.guestMessage.slice(0, 350)) },
              { type: "text", text: templateParam(params.adminReply.slice(0, 350)) },
            ],
          },
        ],
      },
    },
    creds
  );
}

/**
 * Sends a plain text WhatsApp message to an arbitrary number — used to reply
 * directly to a public inquiry that came in via this same WhatsApp number
 * (e.g. someone messaging the Google Business Profile's WhatsApp button; see
 * the webhook's handlePublicWhatsAppInquiry). Free text works here (no
 * Meta-approved template needed, unlike sendChatWidgetAnswerViaWhatsApp
 * below) because the recipient messaged this number first, which opens a
 * 24-hour customer-service window under Meta's rules — replying within that
 * window doesn't require a template. Non-fatal by design at the call site,
 * same convention as the other send helpers here.
 */
export async function sendWhatsAppTextTo(to: string, text: string, organizationId?: string): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isConfigured(creds)) {
    throw new WhatsAppError("WhatsApp isn't configured — missing access token or phone number id.");
  }

  return postWhatsAppMessage(
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text, preview_url: false },
    },
    creds
  );
}

/**
 * Notifies Gabriel (the on-site property manager) that a guest asked about a
 * paid add-on experience, via the Meta-approved WhatsApp template configured
 * as WHATSAPP_SERVICE_REQUEST_TEMPLATE. A template is required (rather than
 * free text) because Gabriel won't have an open 24-hour customer-service
 * window with this WhatsApp number until he's messaged it at least once —
 * see README's WhatsApp section for the exact template body to submit for
 * Meta approval. Params fill the template's {{1}}, {{2}}, {{3}}, {{4}}
 * placeholders in order: property name, guest name, guest phone, request
 * summary. Non-fatal by design at the call site — callers should catch
 * WhatsAppError and log it rather than block the guest-facing send.
 */
export async function notifyGabrielOfServiceRequest(
  params: {
    propertyName: string;
    guestName: string;
    guestPhone: string;
    requestSummary: string;
  },
  organizationId?: string
): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isGabrielConfigured(creds)) {
    throw new WhatsAppError(
      "Gabriel auto-notify isn't configured — missing WHATSAPP_GABRIEL_NUMBER or WHATSAPP_SERVICE_REQUEST_TEMPLATE."
    );
  }

  return postTemplateWithLanguageFallback(
    {
      messaging_product: "whatsapp",
      to: creds.gabrielNumber,
      type: "template",
      template: {
        name: config.whatsappServiceRequestTemplate,
        language: { code: config.whatsappTemplateLanguage },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: templateParam(params.propertyName) },
              { type: "text", text: templateParam(params.guestName) },
              { type: "text", text: templateParam(params.guestPhone) },
              // Meta caps a template's total filled-in body at 1024 characters
              // across all placeholders combined (confirmed 2026-08-01). The
              // fixed template wording plus property name/guest name/phone
              // reliably fits in under ~300 characters even for long names, so
              // 600 here leaves solid headroom while comfortably fitting a
              // real multi-item request in full (Nyree Tanielian's 4-item jet
              // ski/breakfast/boat/pool message was 415 characters end to end
              // — this used to get cut off mid-sentence at the old 300 limit).
              { type: "text", text: templateParam(params.requestSummary.slice(0, 600)) },
            ],
          },
        ],
      },
    },
    creds
  );
}

/**
 * Delivers a chat-widget answer to a website visitor's phone via the
 * Meta-approved WHATSAPP_CHAT_REPLY_TEMPLATE — used as a fallback when the
 * visitor has left the site before Seni's answer was ready (see
 * lib/chatEscalations.ts's getChatEscalationsNeedingFallback). A template is
 * required rather than free text because there's no open 24-hour
 * customer-service window with an anonymous visitor's number — they've never
 * messaged this WhatsApp number at all. Params fill {{1}} (visitor's name)
 * and {{2}} (the answer). Non-fatal by design at the call site — same
 * pattern as notifyGabrielOfServiceRequest.
 */
export async function sendChatWidgetAnswerViaWhatsApp(
  params: {
    visitorPhone: string;
    visitorName: string;
    answer: string;
  },
  organizationId?: string
): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isChatReplyConfigured(creds)) {
    throw new WhatsAppError(
      "Chat-widget WhatsApp fallback isn't configured — missing WHATSAPP_CHAT_REPLY_TEMPLATE setup."
    );
  }

  return postTemplateWithLanguageFallback(
    {
      messaging_product: "whatsapp",
      to: params.visitorPhone,
      type: "template",
      template: {
        name: config.whatsappChatReplyTemplate,
        language: { code: config.whatsappTemplateLanguage },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: templateParam(params.visitorName) },
              // Same 1024-char combined-body cap as the Gabriel template — see
              // its comment above. 600 leaves headroom for a full answer.
              { type: "text", text: templateParam(params.answer.slice(0, 600)) },
            ],
          },
        ],
      },
    },
    creds
  );
}

/**
 * Notifies a vendor via the Meta-approved WHATSAPP_VENDOR_NOTIFY_TEMPLATE
 * that they've been assigned a work order — mirrors
 * notifyGabrielOfServiceRequest above, except the recipient number varies per
 * vendor (Vendor.contactPhone, from lib/billPay.ts) rather than being a
 * single fixed configured number. A template is required for the same
 * reason as Gabriel's: a vendor's phone has essentially never messaged this
 * WhatsApp number before, so there's no open 24-hour customer-service
 * session to send free text in. Params fill the template's {{1}}..{{4}}
 * placeholders in order: vendor name, property name, work order title +
 * priority, description. Non-fatal by design at the call site — see
 * lib/maintenanceVendorNotify.ts.
 */
export async function notifyVendorOfWorkOrder(
  params: {
    vendorPhone: string;
    vendorName: string;
    propertyName: string;
    workOrderTitle: string;
    workOrderDescription: string;
    priority: string;
  },
  organizationId?: string
): Promise<string> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isVendorConfigured(creds)) {
    throw new WhatsAppError("Vendor auto-notify isn't configured — missing WHATSAPP_VENDOR_NOTIFY_TEMPLATE.");
  }

  return postTemplateWithLanguageFallback(
    {
      messaging_product: "whatsapp",
      to: params.vendorPhone,
      type: "template",
      template: {
        name: config.whatsappVendorNotifyTemplate,
        language: { code: config.whatsappTemplateLanguage },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: templateParam(params.vendorName) },
              { type: "text", text: templateParam(params.propertyName) },
              { type: "text", text: `${params.workOrderTitle} (${params.priority})` },
              // Same 1024-char combined-body cap as the other templates above.
              { type: "text", text: templateParam((params.workOrderDescription || "No further details provided.").slice(0, 600)) },
            ],
          },
        ],
      },
    },
    creds
  );
}

export type IncomingWhatsAppMessage = {
  from: string; // sender's WhatsApp number, E.164 without "+"
  wamid: string;
  /** wamid of the message this one is a swipe-to-reply to, if any. Used to
   * figure out which pending draft an approval reply is about. */
  contextWamid?: string;
  /** WhatsApp's own display name for the sender (from the payload's
   * top-level "contacts" array), when Meta includes one. Only meaningful for
   * messages from unrecognized senders (a public inquiry) — used as a
   * fallback display name since there's no OwnerRez guest record to pull a
   * real name from. Seni's and Gabriel's own messages never need this. */
  profileName?: string;
} & (
  | { type: "text"; text: string }
  // A photo or PDF Seni forwarded — see lib/billForward.ts. Media messages
  // are unambiguous: the text-based approval flow (yes/no/custom reply)
  // never involves an attachment, so any message with type "image" or
  // "document" is routed to bill intake instead, never to draft approval.
  | { type: "image"; mediaId: string; mimeType: string; caption?: string }
  | { type: "document"; mediaId: string; mimeType: string; filename?: string; caption?: string }
);

/**
 * Parses a WhatsApp Cloud API webhook POST body into a flat list of inbound
 * messages (text or media). Defensive about shape since Meta's payload
 * nests several levels deep and can include non-message "changes" (status
 * updates, etc.) that should just be ignored.
 */
export function parseIncomingWhatsAppMessages(body: unknown): IncomingWhatsAppMessage[] {
  const results: IncomingWhatsAppMessage[] = [];
  if (!body || typeof body !== "object") return results;

  const entries = (body as Record<string, unknown>).entry;
  if (!Array.isArray(entries)) return results;

  for (const entry of entries) {
    const changes = (entry as Record<string, unknown>)?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = (change as Record<string, unknown>)?.value as Record<string, unknown> | undefined;
      const messages = value?.messages;
      if (!Array.isArray(messages)) continue;

      // Meta includes a top-level "contacts" array alongside "messages",
      // mapping each sender's wa_id to their WhatsApp display name — build a
      // quick lookup so unrecognized senders (a public inquiry, e.g. via the
      // Google Business Profile's WhatsApp button) get a real name instead
      // of just a phone number. Seni's and Gabriel's messages never need
      // this since they're already known contacts.
      const profileNames = new Map<string, string>();
      const contacts = value?.contacts;
      if (Array.isArray(contacts)) {
        for (const contact of contacts) {
          const c = contact as Record<string, unknown>;
          const waId = c.wa_id;
          const name = (c.profile as Record<string, unknown> | undefined)?.name;
          if (typeof waId === "string" && typeof name === "string" && name.trim()) {
            profileNames.set(waId, name.trim());
          }
        }
      }

      for (const msg of messages) {
        const m = msg as Record<string, unknown>;
        const wamid = m.id;
        const from = m.from;
        if (typeof wamid !== "string" || typeof from !== "string") continue;

        const context = m.context as Record<string, unknown> | undefined;
        const contextWamid = typeof context?.id === "string" ? context.id : undefined;
        const profileName = profileNames.get(from);

        if (m.type === "text") {
          const text = (m.text as Record<string, unknown> | undefined)?.body;
          if (typeof text !== "string") continue;
          results.push({ from, wamid, contextWamid, profileName, type: "text", text });
        } else if (m.type === "image") {
          const image = m.image as Record<string, unknown> | undefined;
          const mediaId = image?.id;
          const mimeType = image?.mime_type;
          if (typeof mediaId !== "string" || typeof mimeType !== "string") continue;
          const caption = typeof image?.caption === "string" ? image.caption : undefined;
          results.push({ from, wamid, contextWamid, profileName, type: "image", mediaId, mimeType, caption });
        } else if (m.type === "document") {
          const document = m.document as Record<string, unknown> | undefined;
          const mediaId = document?.id;
          const mimeType = document?.mime_type;
          if (typeof mediaId !== "string" || typeof mimeType !== "string") continue;
          const filename = typeof document?.filename === "string" ? document.filename : undefined;
          const caption = typeof document?.caption === "string" ? document.caption : undefined;
          results.push({ from, wamid, contextWamid, profileName, type: "document", mediaId, mimeType, filename, caption });
        }
        // else: ignore reactions, audio, stickers, location, status updates, etc.
      }
    }
  }

  return results;
}

/**
 * Downloads a media attachment (image/document) from the WhatsApp Cloud
 * API — a two-step process: first resolve the media id to a short-lived
 * download URL, then fetch that URL with the same bearer token. Used by
 * lib/billForward.ts to pull a bill photo/PDF Seni forwarded so it can be
 * handed to Claude for extraction. Meta's media URLs and the underlying
 * files themselves expire after a while, so this must be called promptly
 * when the webhook fires — nothing here persists the raw bytes long-term.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  organizationId?: string
): Promise<{ bytes: Buffer; mimeType: string }> {
  const creds = await resolveWhatsAppCredentials(organizationId);
  if (!isConfigured(creds)) {
    throw new WhatsAppError("WhatsApp isn't configured — missing access token or phone number id.");
  }

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!metaRes.ok) {
    throw new WhatsAppError(`Couldn't resolve media id ${mediaId}: ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new WhatsAppError(`Media id ${mediaId} resolved with no download URL.`);

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!fileRes.ok) {
    throw new WhatsAppError(`Couldn't download media ${mediaId}: ${fileRes.status}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  return { bytes: Buffer.from(arrayBuffer), mimeType: meta.mime_type ?? "application/octet-stream" };
}

// Compare digits only, in case one side has a leading "+" and the other doesn't.
function normalizeNumber(n: string): string {
  return n.replace(/\D/g, "");
}

/** Only accept messages from Seni's own configured WhatsApp number — this is
 * a single-user approval channel, not a public inbox.
 *
 * Deliberately still reads the global config.* value (not per-org) — unlike
 * the send functions above, this runs inside the inbound webhook, BEFORE
 * anything is known about which organization a message belongs to (there's
 * currently one shared Meta WABA/phone number for the whole app). Routing
 * inbound webhook traffic to the right tenant is real remaining Phase 3 work
 * (see lib/whatsapp.ts's module comment / task #277), not something this
 * per-credential refactor can safely guess at. */
export function isFromAuthorizedSender(from: string): boolean {
  return normalizeNumber(from) === normalizeNumber(config.whatsappRecipientNumber);
}

/** True for messages from Gabriel (the on-site property manager)'s own
 * number, when configured — used so a text from Gabriel to this same
 * WhatsApp number is never mistaken for a public GBP inquiry (see the
 * webhook's handlePublicWhatsAppInquiry). Gabriel isn't a customer asking a
 * business question, so his messages are just ignored, same as before this
 * feature existed. */
export function isFromGabriel(from: string): boolean {
  if (!config.whatsappGabrielNumber) return false;
  return normalizeNumber(from) === normalizeNumber(config.whatsappGabrielNumber);
}
