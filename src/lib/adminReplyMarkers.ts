import { redisGet, redisSet } from "./redis";
import { getDefaultOrganizationId } from "./organizations";

// Admin-reply visibility (2026-08-18, Seni's ask: "I need to be able to see
// both new admin responses and new guest responses to my whatsapp because
// there are other admin that might reply directly in OwnerRez").
//
// Two content-hash markers, both in Redis, both keyed on a normalized reading
// of the message BODY (not an id) because the two sides that need to agree
// never share ids: the CRM's own send path only knows the text it posted,
// while the cron/webhook later see OwnerRez's copy of that message with a
// fresh OwnerRez message id.
//
//   1. crm-sent:{hash}  — set by lib/ownerrez.ts sendMessage() the moment the
//      CRM posts ANY message into a thread (approval YES, dashboard reply,
//      EDIT:, campaign sends). Checked before notifying "an admin replied" so
//      Seni's own approved replies don't echo back to him as if a co-admin
//      had jumped in. 48h TTL — far longer than the cron's detection lag.
//   2. admin-notified:{hash} — set-and-check dedupe so the webhook fast-path
//      and the 1-minute cron (which both observe the same new host message)
//      can't each ping Seni for it. Same pattern as pendingDrafts.ts's
//      alreadyAlertedRecently. 24h TTL.
//
// Known soft spot, deliberate: if OwnerRez rewrites the body it echoes back
// (e.g. appended channel signature), the crm-sent hash won't match and Seni
// gets one redundant "admin replied" ping for his own send — noisy, never
// harmful, and self-evident from the text. All helpers fail toward "not
// seen" so a Redis hiccup can only cause an extra ping, never a missed one.

function contentKeyFragment(body: string): string {
  const normalized = body.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 400);
  let h = 0;
  for (let i = 0; i < normalized.length; i++) h = (Math.imul(31, h) + normalized.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const CRM_SENT_TTL_SECONDS = 48 * 60 * 60;
const ADMIN_NOTIFIED_TTL_SECONDS = 24 * 60 * 60;

/** Called by lib/ownerrez.ts sendMessage() after a successful thread post. */
export async function markCrmSentReply(body: string, organizationId?: string): Promise<void> {
  if (!body.trim()) return;
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  await redisSet(`admin-reply:${orgId}:crm-sent:${contentKeyFragment(body)}`, "1", {
    exSeconds: CRM_SENT_TTL_SECONDS,
  }).catch(() => {});
}

/** true when this exact text was recently posted by the CRM itself. */
export async function wasCrmSentReply(body: string, organizationId?: string): Promise<boolean> {
  if (!body.trim()) return false;
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const seen = await redisGet(`admin-reply:${orgId}:crm-sent:${contentKeyFragment(body)}`).catch(() => null);
  return Boolean(seen);
}

/** Set-and-check: returns true if this admin reply was already notified
 * (by either the webhook or the cron); otherwise marks it and returns false.
 * Marks BEFORE the send on purpose — an informational ping that fails is
 * dropped rather than retried, so it can never turn into a repeat-page loop. */
export async function alreadyNotifiedAdminReply(body: string, organizationId?: string): Promise<boolean> {
  if (!body.trim()) return false;
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const key = `admin-reply:${orgId}:notified:${contentKeyFragment(body)}`;
  const seen = await redisGet(key).catch(() => null);
  if (seen) return true;
  await redisSet(key, "1", { exSeconds: ADMIN_NOTIFIED_TTL_SECONDS }).catch(() => {});
  return false;
}
