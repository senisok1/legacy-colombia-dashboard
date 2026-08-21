// Construction overdue-item alerts — WhatsApp + email (2026-08-20, Seni's
// ask: "when the est. completion date is due turn the 'est. completion:'
// red and send out whatsapp messages to me and all users that have access
// to"; extended 2026-08-21, Seni's ask: "send an email and a whatsapp
// message to each user that has access to view or edit that tab... add the
// name of the specific property in the subject of the email or whatsapp so
// the user can identify it immediately").
//
// Runs from api/cron/construction-overdue once a day, across EVERY property
// group (widened 2026-08-21 alongside Construction Management's nav
// becoming visible on every property — see
// [[project_construction_management_tab]]; used to be Legacy-Colombia-only).
// Fires once per item+estimated-completion-date pair, to EVERY recipient
// with access to THAT property's tab (CEO role, or CONSTRUCTION role on
// Legacy Colombia only — the CONSTRUCTION login is proxy-locked there
// regardless of nav, see src/proxy.ts) — unlike balanceDueAlerts.ts's single
// Geo recipient, "all users that have access to" means fan out to the whole
// list. Each channel is independently best-effort per recipient: a failed
// email never blocks that recipient's WhatsApp send or any other
// recipient's alert, and vice versa. Seen-key is only written after at
// least one send (either channel, to any recipient) succeeds, so a total
// failure doesn't block the item alerting again tomorrow — see errors[].
import { redisGet, redisSet } from "@/lib/redis";
import { sendTeamTaskRequestTemplate, sendWhatsAppTextTo } from "@/lib/whatsapp";
import { sendEmail } from "@/lib/email";
import { isEmailSendConfigured } from "@/lib/config";
import { logAiActivity } from "@/lib/aiActivity";
import type { ConstructionItem } from "@/lib/construction";

const AGENT_KEY = "construction_management";
const AGENT_NAME = "Construction Management";

// Outlives any realistic gap between estimated-completion-date edits, same
// rationale as balance-due's SEEN_TTL_SECONDS.
const SEEN_TTL_SECONDS = 400 * 24 * 60 * 60;

function seenKey(orgId: string, itemId: string, dueDate: string): string {
  return `construction-overdue-alert:${orgId}:${itemId}:${dueDate}`;
}

/** "2026-08-20" -> "Aug 20, 2026", explicitly UTC so a past-due date never
 * silently shifts a day in negative-UTC-offset zones (same fix as
 * lib/construction.ts's formatEstimatedDate). */
function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function checkConstructionOverdueAlerts(
  items: ConstructionItem[],
  orgId: string,
  recipients: { phone: string | null; email: string | null; name: string }[],
  propertyLabel: string
): Promise<{
  alerted: { itemId: string; title: string; dueDate: string }[];
  errors: { itemId: string; error: string }[];
}> {
  const alerted: { itemId: string; title: string; dueDate: string }[] = [];
  const errors: { itemId: string; error: string }[] = [];

  if (recipients.length === 0) return { alerted, errors };

  const today = new Date().toISOString().slice(0, 10);

  for (const item of items) {
    if (item.completed) continue;
    if (!item.estimatedCompletionDate) continue;
    if (item.estimatedCompletionDate > today) continue;

    const dueDate = item.estimatedCompletionDate;
    const key = seenKey(orgId, item.id, dueDate);
    if (await redisGet(key)) continue;

    const dueDisplay = formatDate(dueDate);
    // Property name leads every surface (2026-08-21, Seni's ask: "add the
    // name of the specific property in the subject... so the user can
    // identify it immediately") — the WhatsApp template's title param is
    // the first thing a recipient sees, the free-text fallback's first
    // line, and the email subject all lead with it, not just the
    // description body further down.
    const titleWithProperty = `${propertyLabel}: ${item.title}`;
    const description = `${propertyLabel}${item.category ? ` — ${item.category}` : ""} — estimated completion has passed. Check Construction Management.`;
    const emailSubject = `Overdue construction item — ${propertyLabel}: "${item.title}"`;
    const emailBody =
      `${propertyLabel} — an item in Construction Management is overdue:\n\n` +
      `"${item.title}"${item.category ? ` (${item.category})` : ""}\n` +
      `Was due: ${dueDisplay}\n\n` +
      `Open the Construction Management tab to check on it.`;

    let anySent = false;
    for (const recipient of recipients) {
      const recipientErrors: string[] = [];

      if (recipient.phone) {
        try {
          try {
            await sendTeamTaskRequestTemplate(
              {
                to: recipient.phone,
                requesterName: "Construction Management",
                title: titleWithProperty.slice(0, 100),
                neededBy: dueDisplay,
                description,
              },
              orgId
            );
          } catch {
            // Carrier template not approved yet (or transient failure) —
            // best effort free text, deliverable only if that recipient's
            // 24h session window is open.
            await sendWhatsAppTextTo(
              recipient.phone,
              `⚠️ ${propertyLabel} — Overdue: "${item.title}"${item.category ? ` (${item.category})` : ""}\n` +
                `Was due ${dueDisplay}\n\n` +
                `Check Construction Management.`,
              orgId
            );
          }
          anySent = true;
        } catch (err) {
          recipientErrors.push(`whatsapp: ${err instanceof Error ? err.message : "Unknown error."}`);
        }
      }

      // Email is a parallel, independently best-effort channel (same
      // philosophy as lib/alertEmail.ts) — a failed email never blocks this
      // recipient's WhatsApp send, and vice versa.
      if (recipient.email && isEmailSendConfigured()) {
        try {
          const html = `<div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#1c1917;">${emailBody
            .split("\n")
            .map((line) => `<p style="margin:0 0 10px;">${esc(line) || "&nbsp;"}</p>`)
            .join("")}</div>`;
          await sendEmail({ to: recipient.email, subject: emailSubject, html, text: emailBody });
          anySent = true;
        } catch (err) {
          recipientErrors.push(`email: ${err instanceof Error ? err.message : "Unknown error."}`);
        }
      }

      if (recipientErrors.length > 0) {
        errors.push({ itemId: item.id, error: `${recipient.name}: ${recipientErrors.join("; ")}` });
      }
    }

    if (anySent) {
      await redisSet(key, "1", { exSeconds: SEEN_TTL_SECONDS });
      alerted.push({ itemId: item.id, title: item.title, dueDate });

      await logAiActivity(
        {
          agentKey: AGENT_KEY,
          agentDisplayName: AGENT_NAME,
          task: "Overdue construction item alert",
          trigger: `"${item.title}" was due ${dueDisplay} and is still open`,
          dataReviewed: { itemId: item.id, title: item.title, category: item.category, dueDate },
          communicationSent: {
            channel: "whatsapp+email",
            to: recipients.map((r) => r.name).join(", "),
            text: `Overdue: "${item.title}" — ${propertyLabel} — due ${dueDisplay}`,
          },
          actionTaken: `Sent overdue alert (WhatsApp + email) to ${recipients.length} recipient(s)`,
          result: "sent",
        },
        orgId
      );
    }
  }

  return { alerted, errors };
}
