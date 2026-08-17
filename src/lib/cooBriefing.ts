import { config, isAiReplyConfigured, isRedisConfigured } from "./config";
import { redisGet, redisSet } from "./redis";
import { logAiActivity } from "./aiActivity";
import { getDefaultOrganizationId } from "./organizations";
import { resolveAnthropicApiKey } from "./credentials";
import type { ExecutiveReport } from "./executiveReport";

// AI COO (2026-08-02) — Seni's explicit ask after most of the Legacy AI
// Company vision's 10 specialized agents shipped individually: something
// that reads ACROSS all of them, the way a real COO would, instead of
// leaving him to notice cross-domain patterns himself from a dozen separate
// per-agent dashboards. This is purely a synthesis/narrative layer — it
// never takes any action, never writes to anything but its own AI Activity
// log entry, and never invents a number: every fact it's allowed to discuss
// is already sitting in the ExecutiveReport object it's given. Folded into
// the existing daily report (Seni's choice over a separate tab) rather than
// yet another place to check.

const AGENT_KEY = "ai_coo";
const AGENT_NAME = "AI COO";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Regenerating on every page view would mean a Claude call per Reports-tab
// visit for no real benefit — the underlying data only meaningfully changes
// day to day. Cached once per ET calendar day, same cadence as the 5am ET
// report delivery, using redis (falls back to "regenerate every call" if
// redis isn't configured — acceptable since that's a smaller, rarer
// deployment shape in this app, same fallback pattern as
// revenueManager.ts's getWeekdayWeekendRates).
const CACHE_TTL_SECONDS = 20 * 60 * 60; // ~20h — same rationale as getWeekdayWeekendRates

export type CooBriefing = {
  generatedAt: string;
  narrative: string;
  priorities: string[];
};

// Phase 3: namespaced by org id so a second tenant's daily briefing doesn't
// silently read/overwrite the first tenant's cached narrative for the day —
// same fix as revenueManager.ts's getWeekdayWeekendRates cache key.
function cacheKeyForToday(organizationId: string): string {
  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  return `coo:briefing:${organizationId}:${todayEt}`;
}

const SYSTEM_PROMPT = `You are the AI COO for Legacy Estate Rentals — you sit above the specialized single-purpose AI agents this business runs (Revenue Manager, Guest Experience/Messaging, Maintenance, Bill Pay, Sales/Leads pipeline, Lifecycle Marketing, Marketing/SEO content, Reputation Manager) and write a short daily briefing for the owner, Seni.

Your job is NOT to repeat the numbers he's about to see below — he can read those himself. Your job is to say what a human COO would say after actually reading all of it together: which 2-3 things matter most right now, and any pattern that only shows up when you look ACROSS domains (for example: soft occupancy + a below-market AI rate recommendation + slower lead conversion, taken together, might mean real demand softness rather than a pricing problem; or a spike in maintenance issues right before a run of 5-star-dependent bookings might be worth flagging even if neither number alone looks urgent).

Judging performance fairly:
- The data includes propertyTenure — how many months this specific property has actually been in service, and how many bookings it has taken all-time. USE IT. A property that has been live for two months is in ramp-up: thin forward booking pace, few reviews, a 0% repeat-guest rate and heavier last-minute discounting are all NORMAL and expected at that stage, not warning signs. Say so plainly instead of describing them as problems.
- For a new property (isNewProperty: true), assess whether it is building momentum for its age — early ADR, occupancy achieved so far, and whether bookings are accumulating — rather than measuring it against a stabilised listing's forward pace.
- For an established property, the usual standards apply.
- Never describe a metric as "alarming" or "deteriorating" without first checking whether the property is simply young.

Ground rules:
- Never invent or estimate a number that isn't in the data you're given. If you reference a figure, it must come directly from the JSON provided.
- If the data genuinely doesn't support a strong cross-domain read today, say so plainly ("nothing across these agents compounds today — the main thing is just X") rather than manufacturing false urgency or a forced narrative.
- Be concrete and specific, not generic business-speak. No filler like "continue monitoring" or "stay the course."
- Keep the narrative to 2-4 sentences.

Respond with ONLY a JSON object (no markdown fences, no other text):
{
  "narrative": "2-4 sentences, plain English, written directly to Seni",
  "priorities": ["up to 3 short, concrete, specific action items or watch-items, or an empty array if truly nothing rises above the noise today"]
}`;

export class CooBriefingError extends Error {}

/** The exact payload the model is shown. Extracted 2026-08-17 so the cache
 * key can be derived from it — see contentFingerprint below. */
function briefingContext(report: ExecutiveReport) {
  // Strip fields that would be redundant/noisy for the model (raw reasoning
  // text per rate-snapshot date isn't needed for a cross-domain read) and
  // anything that could recurse (there is no cooBriefing field on the input
  // report at this point, since this runs before it's attached).
  return {
    propertyLabel: report.propertyLabel,
    propertyTenure: report.propertyTenure,
    occupancy30d: report.occupancy30d,
    adrGross: report.adrGross,
    revParGross: report.revParGross,
    directBookingPct: report.directBookingPct,
    revenueYtdGross: report.revenueYtdGross,
    revenueMtdGross: report.revenueMtdGross,
    revenueTodayGross: report.revenueTodayGross,
    // Paid extras (2026-08-17). Included so the AI COO can reason about
    // ancillary revenue and attach rate — without this the briefing would
    // keep describing revenue as if stays were the only source. houseRevenue
    // is the only extras figure that is revenue; commission is a cost.
    extrasYtd: report.extrasYtd?.count
      ? {
          houseRevenue: report.extrasYtd.houseRevenue,
          commission: report.extrasYtd.commission,
          attachRatePct: report.extrasYtd.attachRatePct,
          houseRevenuePerStay: report.extrasYtd.houseRevenuePerStay,
          byKind: report.extrasYtd.byKind.map((k) => ({ label: k.label, houseRevenue: k.houseRevenue, count: k.count })),
        }
      : null,
    totalRevenueYtdGross: report.totalRevenueYtdGross,
    bookingPace: report.bookingPace,
    inquiries: report.inquiries,
    guestResponseTime: report.guestResponseTime,
    weekdayWeekendRate: report.weekdayWeekendRate,
    lastMinuteDiscount: report.lastMinuteDiscount,
    rateComparison: report.rateComparison,
    cancellation: report.cancellation,
    avgLengthOfStayNights: report.avgLengthOfStayNights,
    repeatGuest: report.repeatGuest,
    reputation: report.reputation,
    maintenance: report.maintenance,
    bills: report.bills,
    approvalsPending: report.approvalsPending,
    urgentApprovals: report.urgentApprovals,
    newLeads: report.newLeads,
    campaignCandidates: report.campaignCandidates,
    contentIdeasAwaitingReview: report.contentIdeasAwaitingReview,
    topAttention: report.topAttention,
  };
}

/** Short stable hash of the briefing inputs.
 *
 * WHY THIS EXISTS (2026-08-17): the briefing is cached for ~20h, and Seni
 * reported Legacy Alva's summary still quoting Legacy Colombia's numbers
 * AFTER the underlying data was correctly scoped. The scoping was fine — the
 * CACHE wasn't. Alva's briefing had been generated earlier that day, before
 * campaign candidates were property-scoped, so it described "98 lifecycle
 * campaign candidates" (Colombia's) while the report beside it correctly
 * said 0. A per-day, per-property key can't detect that, because neither the
 * day nor the property changed — only the data did.
 *
 * Including a fingerprint of the actual inputs makes a stale narrative
 * structurally impossible: if any number the model was shown changes, the
 * key changes and a fresh briefing is written. It also means every past
 * data-correctness fix self-heals instead of lingering for up to 20 hours. */
function contentFingerprint(report: ExecutiveReport): string {
  const json = JSON.stringify(briefingContext(report));
  let h = 0;
  for (let i = 0; i < json.length; i++) {
    h = (Math.imul(31, h) + json.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

async function generateBriefing(report: ExecutiveReport, organizationId?: string): Promise<CooBriefing> {
  const context = briefingContext(report);

  const apiKey = await resolveAnthropicApiKey(organizationId);
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
        { role: "user", content: `Today's data across every agent:\n${JSON.stringify(context, null, 2)}` },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CooBriefingError(`Anthropic API returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new CooBriefingError("Anthropic API returned no briefing text.");

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: { narrative?: unknown; priorities?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { narrative?: unknown; priorities?: unknown };
  } catch {
    throw new CooBriefingError("Couldn't parse a JSON object from the AI COO's response.");
  }

  const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim() : "";
  const priorities = Array.isArray(parsed.priorities)
    ? parsed.priorities.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];

  if (!narrative) throw new CooBriefingError("AI COO response had no narrative text.");

  return { generatedAt: new Date().toISOString(), narrative, priorities };
}

/** Returns today's cached briefing if one exists, otherwise generates a new
 * one, caches it, and logs the generation to AI Activity. Returns null (not
 * an error) when ANTHROPIC_API_KEY isn't configured — callers should treat
 * that as "feature not available yet," same as this app's other optional
 * data sources. A generation failure also resolves to null rather than
 * throwing, so a briefing outage never breaks the rest of the daily report —
 * the failure is still logged to AI Activity with result: 'failed' so it's
 * visible in the audit trail. */
export async function getCooBriefing(
  report: ExecutiveReport,
  organizationId?: string,
  propertyGroupId?: string
): Promise<CooBriefing | null> {
  if (!isAiReplyConfigured()) return null;
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  // Group-namespaced (2026-08-17). This caches an AI-written narrative about
  // ONE property's day; sharing the key meant the first property viewed each
  // day had its briefing served to every other property.
  // Key = org + day + property + fingerprint of the numbers the model sees.
  // The fingerprint is what prevents a briefing outliving its data — see
  // contentFingerprint's comment for the bug that made this necessary.
  const cacheKey = `${cacheKeyForToday(orgId)}:${propertyGroupId ?? "legacy-colombia"}:${contentFingerprint(
    report
  )}`;
  if (isRedisConfigured()) {
    const cached = await redisGet(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as CooBriefing;
      } catch {
        // fall through and regenerate
      }
    }
  }

  try {
    const briefing = await generateBriefing(report, orgId);
    if (isRedisConfigured()) {
      await redisSet(cacheKey, JSON.stringify(briefing), { exSeconds: CACHE_TTL_SECONDS });
    }
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Generate daily cross-agent briefing",
      trigger: "Daily executive report build",
      dataReviewed: { metricsConsidered: Object.keys(report).length },
      decision: briefing.narrative,
      actionTaken: `Surfaced ${briefing.priorities.length} priorit${briefing.priorities.length === 1 ? "y" : "ies"} — narrative only, no action taken anywhere`,
      result: "generated",
    }, orgId);
    return briefing;
  } catch (err) {
    const message = err instanceof CooBriefingError || err instanceof Error ? err.message : "Unknown error.";
    await logAiActivity({
      agentKey: AGENT_KEY,
      agentDisplayName: AGENT_NAME,
      task: "Generate daily cross-agent briefing",
      trigger: "Daily executive report build",
      result: "failed",
      error: message,
    }, orgId).catch(() => {});
    return null;
  }
}
