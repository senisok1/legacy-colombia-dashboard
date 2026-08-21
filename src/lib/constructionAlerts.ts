// Construction overdue-item WhatsApp alerts (2026-08-20, Seni's ask: "when
// the est. completion date is due turn the 'est. completion:' red and send
// out whatsapp messages to me and all users that have access to").
//
// Runs from api/cron/construction-overdue once a day, Legacy-Colombia-only
// (DEFAULT_PROPERTY_GROUP_ID — construction is scoped there, unlike
// balance-due which runs across all properties). Fires once per
// item+estimated-completion-date pair, to EVERY recipient with tab access
// (CEO or CONSTRUCTION role + a WhatsApp number on file) — unlike
// balanceDueAlerts.ts's single Geo recipient, "all users that have access
// to" means fan out to the whole list. Seen-key is only written after every
// recipient's send has been attempted, so a partial failure (one number
// bounces) doesn't block the item alerting again tomorrow — see errors[].
import { redisGet, redisSet } from "@/lib/redis";
import { sendTeamTaskRequestTemplate, sendWhatsAppTextTo } from "@/lib/whatsapp";
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

export async function checkConstructionOverdueAlerts(
  items: ConstructionItem[],
  orgId: string,
  recipients: { phone: string; name: string }[],
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
    const description = `${propertyLabel}${item.category ? ` — ${item.category}` : ""} — estimated completion has passed. Check Construction Management.`;

    let anySent = false;
    for (const recipient of recipients) {
      try {
        try {
          await sendTeamTaskRequestTemplate(
            {
              to: recipient.phone,
              requesterName: "Construction Management",
              title: item.title,
              neededBy: dueDisplay,
              description,
            },
            orgId
          );
        } catch {
          // Carrier template not approved yet (or transient failure) — best
          // effort free text, deliverable only if that recipient's 24h
          // session window is open. If this also throws, the outer catch
          // just skips this one recipient; others still get a chance.
          await sendWhatsAppTextTo(
            recipient.phone,
            `⚠️ Overdue — "${item.title}"${item.category ? ` (${item.category})` : ""}\n` +
              `${propertyLabel} — was due ${dueDisplay}\n\n` +
              `Check Construction Management.`,
            orgId
          );
        }
        anySent = true;
      } catch (err) {
        errors.push({
          itemId: item.id,
          error: `${recipient.name}: ${err instanceof Error ? err.message : "Unknown error."}`,
        });
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
            channel: "whatsapp",
            to: recipients.map((r) => r.name).join(", "),
            text: `Overdue: "${item.title}" — due ${dueDisplay}`,
          },
          actionTaken: `Sent overdue WhatsApp alert to ${recipients.length} recipient(s)`,
          result: "sent",
        },
        orgId
      );
    }
  }

  return { alerted, errors };
}
