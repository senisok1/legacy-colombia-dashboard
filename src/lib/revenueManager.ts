import { query, queryOne } from "./db";
import { config, isDbConfigured, isAiReplyConfigured, isLiveModeConfigured, isPriceLabsConfigured, isRedisConfigured } from "./config";
import { getTargetProperty, getTargetProperties, getQuotedNightlyRateCents, OwnerRezApiError } from "./ownerrez";
import { DEFAULT_PROPERTY_GROUP_ID } from "./propertyGroups";
import { getListingPrices, applyDateOverride, PriceLabsError } from "./pricelabs";
import { logAiActivity } from "./aiActivity";
import { redisGet, redisSet } from "./redis";
import { getDefaultOrganizationId } from "./organizations";
import { resolveAnthropicApiKey } from "./credentials";

// Phase 5 of the Legacy AI Company roadmap (see docs/VISION.md) — Revenue
// Manager. runDailyRateSnapshot() below remains a pure read/compare job: it
// NEVER calls a write endpoint against OwnerRez or PriceLabs (see
// lib/ownerrez.ts's getQuotedNightlyRateCents(), which uses OwnerRez's
// `test: true` quote flag, nothing persisted). It exists to build an honest
// track record — AI recommendation vs. PriceLabs vs. what OwnerRez was
// actually quoting — for every upcoming night, continuously.
//
// As of 2026-08-01 (Phase 5b), that track record feeds a second capability:
// applyRateOverride() below, which DOES write — but only ever for one date
// at a time, only ever as the direct result of Seni clicking "Apply this
// rate" in the Revenue Management tab. There is no batch-apply and no
// cron/scheduled path that calls it. See db/migrations/0009_rate_overrides.sql's
// header comment for why the write goes through PriceLabs' Date Specific
// Override API rather than OwnerRez's own spotrates endpoint, and
// lib/pricelabs.ts's applyDateOverride() for the actual HTTP call.

const AGENT_KEY = "revenue_manager";
const AGENT_NAME = "AI Revenue Manager";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// lib/ownerrez.ts's getQuotedNightlyRateCents() creates a real (if
// unpersisted) OwnerRez quote per call — there's no bulk "rate calendar" GET
// endpoint (confirmed against OwnerRez's OpenAPI spec, 2026-07-30).
//
// Originally this sampled just one date per week for ~13 weeks (13 OwnerRez
// calls/day) to keep the daily footprint sane. Extended 2026-08-04 (Seni's
// ask for full calendar coverage, not scattered Mondays-only) to a two-tier
// design instead: every single day for the next
// config.revenueSnapshotDenseDaysAhead days (dense — this is the window that
// actually matters for real pricing decisions), plus one date/week beyond
// that out to config.revenueSnapshotSparseWeeksAhead weeks (sparse — keeps a
// full year of directional visibility without needing ~365 individual
// OwnerRez calls every day). See fullCoverageDates() below.
//
// The real cost of "more dates" isn't Vercel function duration — mapWithConcurrency
// below fans the OwnerRez quote calls, the DB upserts, and the batched
// Claude recommendation calls all out with bounded concurrency, so wall-clock
// time barely moves even though call *volume* is now ~5-8x higher than the
// old 13-date design. If OwnerRez's API ever pushes back on that volume,
// REVENUE_SNAPSHOT_DENSE_DAYS_AHEAD is the knob to turn down.
const OWNERREZ_QUOTE_CONCURRENCY = 8;
const DB_WRITE_CONCURRENCY = 5; // matches lib/db.ts's pool max
const AI_BATCH_SIZE = 20; // dates per Claude call — keeps each response comfortably under max_tokens
const AI_BATCH_CONCURRENCY = 3;

export class RevenueManagerError extends Error {}

/** Runs `fn` over `items` with at most `concurrency` in flight at once —
 * turns what used to be several sequential for-loops (OwnerRez quotes, DB
 * upserts, Claude batches) into bounded-parallel ones so a much larger date
 * count doesn't multiply wall-clock time 1:1. */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function getOrCreateDbPropertyId(ownerRezPropertyId: number, name: string): Promise<string | null> {
  if (!isDbConfigured()) return null;
  const existing = await queryOne<{ id: string }>(
    "select id from properties where ownerrez_property_id = $1",
    [ownerRezPropertyId]
  );
  if (existing) return existing.id;
  const created = await queryOne<{ id: string }>(
    `insert into properties (ownerrez_property_id, name) values ($1, $2)
     on conflict (ownerrez_property_id) do update set name = excluded.name
     returning id`,
    [ownerRezPropertyId, name]
  );
  return created?.id ?? null;
}

/** Every day from tomorrow through `denseDaysAhead` days out (dense), plus
 * one date/week beyond that through `sparseWeeksAhead` weeks out (sparse) —
 * see the header comment above for why this two-tier shape replaced the old
 * "one date/week for 13 weeks" sampling. Returned sorted, de-duplicated
 * (the sparse tier only ever adds weeks past the dense window, but de-dupe
 * defensively in case the two knobs are ever configured to overlap). */
export function fullCoverageDates(denseDaysAhead: number, sparseWeeksAhead: number): string[] {
  const today = new Date();
  const dates = new Set<string>();

  for (let d = 1; d <= denseDaysAhead; d++) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    dt.setUTCDate(dt.getUTCDate() + d);
    dates.add(dt.toISOString().slice(0, 10));
  }

  const denseWeeks = Math.floor(denseDaysAhead / 7);
  for (let w = denseWeeks + 1; w <= sparseWeeksAhead; w++) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    dt.setUTCDate(dt.getUTCDate() + w * 7);
    dates.add(dt.toISOString().slice(0, 10));
  }

  return Array.from(dates).sort();
}

type DateInput = {
  date: string;
  ownerRezRateCents: number | null;
  priceLabsRateCents: number | null;
};

type Recommendation = {
  date: string;
  recommendedRateCents: number | null;
  reasoning: string | null;
  confidence: "high" | "medium" | "low";
};

const SYSTEM_PROMPT = `You are a short-term rental revenue manager giving a SHADOW-MODE recommendation only — nothing you say here changes a live price. For each date given, recommend the nightly rate you'd charge in USD, briefly explain why (weekday/weekend, season, how it compares to the other two numbers given), and rate your own confidence.

The property is "Legacy Colombia" — a luxury waterfront villa in Peñol, Antioquia, Colombia, sleeping up to 18 guests, popular for group getaways and wellness retreats.

For each date you'll be given: the day of week, how many weeks out it is, OwnerRez's currently quoted rate (what's actually live right now, or null if unavailable), and PriceLabs' recommended rate (or null if unavailable). Use both as reference points — you don't have to match either one.

Respond with ONLY a JSON array (no markdown fences, no other text), one object per date given, each with exactly these keys:
{
  "date": "YYYY-MM-DD, matching the input exactly",
  "recommended_rate": a number in USD, or null if you genuinely can't form a view,
  "reasoning": "one or two sentences, plain English, no jargon",
  "confidence": "high", "medium", or "low"
}`;

/** Splits `inputs` into AI_BATCH_SIZE-sized chunks and requests
 * recommendations for each chunk, AI_BATCH_CONCURRENCY at a time — a single
 * Claude call covering the full dense+sparse date list (now potentially
 * 100+ dates, vs. the original design's 13) would risk truncating well past
 * max_tokens. Order of the returned array doesn't matter to callers here
 * (they index results by date via a Map), so chunks can run out of order. */
async function getAiRecommendationsBatched(inputs: DateInput[], organizationId?: string): Promise<Recommendation[]> {
  const chunks: DateInput[][] = [];
  for (let i = 0; i < inputs.length; i += AI_BATCH_SIZE) {
    chunks.push(inputs.slice(i, i + AI_BATCH_SIZE));
  }
  const results = await mapWithConcurrency(chunks, AI_BATCH_CONCURRENCY, (chunk) =>
    getAiRecommendations(chunk, organizationId)
  );
  return results.flat();
}

async function getAiRecommendations(inputs: DateInput[], organizationId?: string): Promise<Recommendation[]> {
  if (!isAiReplyConfigured()) {
    throw new RevenueManagerError("ANTHROPIC_API_KEY isn't set — can't generate recommendations.");
  }

  const payload = inputs.map((i) => {
    const d = new Date(i.date + "T00:00:00Z");
    const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const weeksOut = Math.round((d.getTime() - Date.now()) / (7 * 86400000));
    return {
      date: i.date,
      day_of_week: dayOfWeek,
      weeks_out: weeksOut,
      ownerrez_rate: i.ownerRezRateCents !== null ? i.ownerRezRateCents / 100 : null,
      pricelabs_rate: i.priceLabsRateCents !== null ? i.priceLabsRateCents / 100 : null,
    };
  });

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
      // Scales with batch size (~180 tokens/date is comfortable headroom for
      // the JSON shape below) rather than a flat 2000 — that was fine for the
      // original 13-date batches but would truncate a full AI_BATCH_SIZE=20
      // response for longer reasoning strings.
      max_tokens: Math.min(8000, inputs.length * 180 + 200),
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Recommend a rate for each of these dates:\n${JSON.stringify(payload, null, 2)}` },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RevenueManagerError(`Anthropic API returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new RevenueManagerError("Anthropic API returned no recommendation text.");

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: unknown[];
  try {
    parsed = JSON.parse(cleaned) as unknown[];
  } catch {
    throw new RevenueManagerError("Couldn't parse a JSON array from Claude's recommendation response.");
  }

  return parsed.map((raw) => {
    const r = raw as Record<string, unknown>;
    const confidence = r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low";
    return {
      date: String(r.date ?? ""),
      recommendedRateCents:
        typeof r.recommended_rate === "number" && Number.isFinite(r.recommended_rate)
          ? Math.round(r.recommended_rate * 100)
          : null,
      reasoning: typeof r.reasoning === "string" && r.reasoning.trim() ? r.reasoning.trim() : null,
      confidence,
    };
  });
}

export type RunResult = {
  sampledDates: number;
  snapshotsWritten: number;
  ownerRezErrors: number;
  priceLabsConfigured: boolean;
  priceLabsError: string | null;
};

/** The daily job (see api/cron/revenue-snapshot). For every date returned by
 * fullCoverageDates() (dense daily coverage near-term, sparse weekly further
 * out — see header comment above): reads OwnerRez's actual quoted rate
 * (test-mode quote, nothing persisted), PriceLabs' recommended rate (one
 * bulk call covering the whole calendar), asks Claude for its own
 * recommendation + reasoning (batched — see getAiRecommendationsBatched),
 * and upserts a rate_snapshots row. Always resolves (never throws) for a
 * single missing data source — a run with only OwnerRez data (PriceLabs not
 * configured yet, say) still writes useful rows; only a total failure (DB
 * down, Anthropic down) surfaces as an error, logged to AI Activity either
 * way. */
export async function runDailyRateSnapshot(organizationId?: string): Promise<RunResult> {
  if (!isDbConfigured()) {
    throw new RevenueManagerError("Database isn't connected yet.");
  }
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  const property = await getTargetProperty(orgId);
  const dbPropertyId = await getOrCreateDbPropertyId(property.id, property.name);
  const dates = fullCoverageDates(config.revenueSnapshotDenseDaysAhead, config.revenueSnapshotSparseWeeksAhead);

  // PriceLabs: one call gets the whole calendar back — no per-date looping.
  let priceLabsByDate = new Map<string, number>();
  let priceLabsError: string | null = null;
  if (isPriceLabsConfigured() && config.pricelabsListingId) {
    try {
      // Confirmed 2026-07-31 via PriceLabs' own /listings response: id 413494
      // (Legacy Colombia's primary listing, base $605/min $415, matching the
      // real OwnerRez rates) is registered under pms "ownerrez", not
      // "airbnb" — there's a separate duplicate listing
      // (id 1076161346460191053) synced from the Airbnb channel instead.
      // Using the wrong pms here 400s with "Listing does not exist in
      // PriceLabs" even though the id itself is valid.
      const listing = await getListingPrices(config.pricelabsListingId, "ownerrez");
      if (listing.error) {
        priceLabsError = listing.error;
      } else {
        priceLabsByDate = new Map(listing.dates.map((d) => [d.date, Math.round(d.price * 100)]));
      }
    } catch (err) {
      priceLabsError = err instanceof PriceLabsError || err instanceof Error ? err.message : "Unknown PriceLabs error.";
    }
  }

  // OwnerRez: one test-mode quote call per date, fanned out with bounded
  // concurrency (see OWNERREZ_QUOTE_CONCURRENCY) — with dense coverage now
  // routinely 60-100+ dates, a plain sequential loop here would risk running
  // past the cron's maxDuration. Individual failures (e.g. a date below the
  // property's minimum stay) are tolerated per-date, same as before.
  let ownerRezErrors = 0;
  const ownerRezByDate = new Map<string, number | null>();
  await mapWithConcurrency(dates, OWNERREZ_QUOTE_CONCURRENCY, async (date) => {
    try {
      ownerRezByDate.set(date, await getQuotedNightlyRateCents(date, orgId));
    } catch (err) {
      ownerRezErrors++;
      ownerRezByDate.set(date, null);
      if (err instanceof OwnerRezApiError) {
        console.error(`[revenueManager] OwnerRez quote failed for ${date}`, err.message);
      }
    }
  });

  const inputs: DateInput[] = dates.map((date) => ({
    date,
    ownerRezRateCents: ownerRezByDate.get(date) ?? null,
    priceLabsRateCents: priceLabsByDate.get(date) ?? null,
  }));

  const recommendations = await getAiRecommendationsBatched(inputs, orgId);
  const recByDate = new Map(recommendations.map((r) => [r.date, r]));

  // DB upserts fanned out with bounded concurrency too (matches lib/db.ts's
  // pool max) — sequential one-at-a-time inserts were fine for 13 rows, not
  // for a dense-coverage run of 60-100+.
  const writeResults = await mapWithConcurrency(inputs, DB_WRITE_CONCURRENCY, async (input) => {
    const rec = recByDate.get(input.date);
    await query(
      `insert into rate_snapshots
         (organization_id, property_id, stay_date, run_date, ownerrez_rate_cents, pricelabs_rate_cents,
          ai_recommended_rate_cents, ai_reasoning, ai_confidence)
       values ($1, $2, $3, current_date, $4, $5, $6, $7, $8)
       on conflict (property_id, stay_date, run_date) do update set
         ownerrez_rate_cents = excluded.ownerrez_rate_cents,
         pricelabs_rate_cents = excluded.pricelabs_rate_cents,
         ai_recommended_rate_cents = excluded.ai_recommended_rate_cents,
         ai_reasoning = excluded.ai_reasoning,
         ai_confidence = excluded.ai_confidence`,
      [
        orgId,
        dbPropertyId,
        input.date,
        input.ownerRezRateCents,
        input.priceLabsRateCents,
        rec?.recommendedRateCents ?? null,
        rec?.reasoning ?? null,
        rec?.confidence ?? null,
      ]
    );
    return true;
  });
  const snapshotsWritten = writeResults.filter(Boolean).length;

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Daily rate shadow-comparison snapshot",
    trigger: "Scheduled daily run",
    dataReviewed: {
      denseDaysAhead: config.revenueSnapshotDenseDaysAhead,
      sparseWeeksAhead: config.revenueSnapshotSparseWeeksAhead,
      dateCount: dates.length,
      priceLabsError,
    },
    decision: `Logged recommendations for ${snapshotsWritten} of ${dates.length} covered dates`,
    actionTaken: "Wrote rate_snapshots rows — shadow mode only, no live rate was changed anywhere",
    result: "logged",
  });

  return {
    sampledDates: dates.length,
    snapshotsWritten,
    ownerRezErrors,
    priceLabsConfigured: isPriceLabsConfigured() && Boolean(config.pricelabsListingId),
    priceLabsError,
  };
}

export type RateSnapshotRow = {
  stayDate: string;
  runDate: string;
  ownerRezRateCents: number | null;
  priceLabsRateCents: number | null;
  aiRecommendedRateCents: number | null;
  aiReasoning: string | null;
  aiConfidence: string | null;
};

type RawRow = {
  stay_date: string;
  run_date: string;
  ownerrez_rate_cents: number | null;
  pricelabs_rate_cents: number | null;
  ai_recommended_rate_cents: number | null;
  ai_reasoning: string | null;
  ai_confidence: string | null;
};

/** The latest snapshot per stay_date (whatever the most recent run_date is
 * for that night), soonest night first — powers the Revenue Management tab. */
/** Restricts rate rows to the OwnerRez properties in one property group
 * (2026-08-17). rate_snapshots/rate_overrides already carry a property_id
 * pointing at the local `properties` table, so no new column is needed —
 * the subquery maps that back to OwnerRez ids. A NULL property_id is only
 * shown under the default group, where every legacy row belongs. */
async function ratePropertyFilter(
  organizationId: string,
  propertyGroupId: string | undefined,
  paramIndex: number
): Promise<{ sql: string; params: unknown[] }> {
  if (!propertyGroupId) return { sql: "", params: [] };
  const properties = await getTargetProperties(organizationId, propertyGroupId).catch(() => []);
  const ids = properties.map((p) => p.id);
  const membership = `property_id in (select id from properties where ownerrez_property_id = any($${paramIndex}::int[]))`;
  return {
    sql:
      propertyGroupId === DEFAULT_PROPERTY_GROUP_ID
        ? ` and (property_id is null or ${membership})`
        : ` and ${membership}`,
    params: [ids],
  };
}

export async function getLatestRateSnapshots(
  organizationId?: string,
  propertyGroupId?: string
): Promise<RateSnapshotRow[]> {
  if (!isDbConfigured()) return [];
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const filter = await ratePropertyFilter(orgId, propertyGroupId, 2);
  const rows = await query<RawRow>(
    `select distinct on (stay_date) stay_date, run_date, ownerrez_rate_cents, pricelabs_rate_cents,
            ai_recommended_rate_cents, ai_reasoning, ai_confidence
     from rate_snapshots
     where organization_id = $1${filter.sql}
     order by stay_date asc, run_date desc`,
    [orgId, ...filter.params]
  );
  return rows.map((r) => ({
    stayDate: r.stay_date,
    runDate: r.run_date,
    ownerRezRateCents: r.ownerrez_rate_cents,
    priceLabsRateCents: r.pricelabs_rate_cents,
    aiRecommendedRateCents: r.ai_recommended_rate_cents,
    aiReasoning: r.ai_reasoning,
    aiConfidence: r.ai_confidence,
  }));
}

export type RateComparisonSummary = {
  datesTracked: number;
  aiAvgGross: number | null;
  priceLabsAvgGross: number | null;
  ownerRezAvgGross: number | null;
  ownerRezSampleSize: number;
  /** Average of the per-date (AI - PriceLabs) / PriceLabs, as a percent —
   * positive means the AI is recommending higher than PriceLabs on average. */
  avgAiVsPriceLabsPct: number | null;
};

/** Average AI-recommended vs. PriceLabs-recommended vs. actual live OwnerRez
 * rate, across every upcoming date rate_snapshots is currently tracking.
 * Reuses getLatestRateSnapshots() so this always matches what's shown on the
 * Revenue Management tab — built 2026-08-01 so Seni can watch, in the daily
 * executive report, whether the AI is closing in on (or already beating)
 * PriceLabs before deciding to drop PriceLabs entirely (see
 * lib/pricelabs.ts's header comment for that migration path). OwnerRez's
 * average has a smaller sample size than the other two by nature — a quote
 * only comes back for dates that aren't already booked. */
export async function getRateComparisonSummary(
  organizationId?: string,
  propertyGroupId?: string
): Promise<RateComparisonSummary> {
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const snapshots = await getLatestRateSnapshots(orgId, propertyGroupId);
  const avg = (nums: number[]) => (nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null);

  const aiCents = snapshots.map((s) => s.aiRecommendedRateCents).filter((c): c is number => c !== null);
  const priceLabsCents = snapshots.map((s) => s.priceLabsRateCents).filter((c): c is number => c !== null);
  const ownerRezCents = snapshots.map((s) => s.ownerRezRateCents).filter((c): c is number => c !== null);

  const diffs = snapshots
    .filter((s) => s.aiRecommendedRateCents !== null && s.priceLabsRateCents !== null && s.priceLabsRateCents !== 0)
    .map((s) => ((s.aiRecommendedRateCents as number) - (s.priceLabsRateCents as number)) / (s.priceLabsRateCents as number) * 100);

  const aiAvg = avg(aiCents);
  const priceLabsAvg = avg(priceLabsCents);
  const ownerRezAvg = avg(ownerRezCents);

  return {
    datesTracked: snapshots.length,
    aiAvgGross: aiAvg !== null ? Math.round(aiAvg) / 100 : null,
    priceLabsAvgGross: priceLabsAvg !== null ? Math.round(priceLabsAvg) / 100 : null,
    ownerRezAvgGross: ownerRezAvg !== null ? Math.round(ownerRezAvg) / 100 : null,
    ownerRezSampleSize: ownerRezCents.length,
    avgAiVsPriceLabsPct: diffs.length > 0 ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null,
  };
}

// ---------- Apply a rate live (Phase 5b — approval-gated, single-date) ----------

export type ApplyRateOverrideInput = {
  stayDate: string;
  priceCents: number;
  reason?: string;
  /** 'manual' (default) — Seni's own "Apply this rate" click in the Revenue
   * Management tab (api/revenue/apply/route.ts). 'auto_apply_band' — the
   * autopilot pass below (runAutoApplyPass), only ever reachable when Seni
   * has explicitly set REVENUE_AUTO_APPLY_ENABLED=true. See
   * db/migrations/0014_rate_override_source.sql. */
  triggeredBy?: "manual" | "auto_apply_band";
};

export type ApplyRateOverrideResult = {
  stayDate: string;
  appliedPriceCents: number;
};

/** Pushes ONE date's rate live via PriceLabs' Date Specific Override API
 * (see lib/pricelabs.ts's applyDateOverride()). Two callers: manual —
 * api/revenue/apply/route.ts, reachable from an explicit "Apply this rate"
 * click Seni takes on one date at a time in the Revenue Management tab; and
 * autopilot — runAutoApplyPass() below, only reachable when Seni has
 * explicitly enabled REVENUE_AUTO_APPLY_ENABLED (ships off). No other path
 * calls this function. PriceLabs syncs the change into OwnerRez on its own
 * schedule; it is NOT instant. Every call — success or failure — writes a
 * rate_overrides row (labeled by triggeredBy) and an AI Activity log entry,
 * so there's always an audit trail even when the PriceLabs call itself
 * fails. */
export async function applyRateOverride(
  input: ApplyRateOverrideInput,
  organizationId?: string
): Promise<ApplyRateOverrideResult> {
  if (!isDbConfigured()) {
    throw new RevenueManagerError("Database isn't connected yet.");
  }
  if (!isPriceLabsConfigured() || !config.pricelabsListingId) {
    throw new RevenueManagerError("PriceLabs isn't configured yet — can't push a live rate.");
  }
  if (!Number.isFinite(input.priceCents) || input.priceCents <= 0) {
    throw new RevenueManagerError("Invalid price.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.stayDate)) {
    throw new RevenueManagerError("Invalid date.");
  }
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  const property = await getTargetProperty(orgId);
  const dbPropertyId = await getOrCreateDbPropertyId(property.id, property.name);

  // Pulled purely for the audit trail (rate_overrides.ai_recommended_rate_cents)
  // — doesn't gate the apply itself, since Seni may type a different number.
  const snapshot = await queryOne<{ ai_recommended_rate_cents: number | null }>(
    `select ai_recommended_rate_cents from rate_snapshots
     where organization_id = $1 and property_id = $2 and stay_date = $3
     order by run_date desc limit 1`,
    [orgId, dbPropertyId, input.stayDate]
  );

  let pricelabsResponse: unknown = null;
  let status: "applied" | "failed" = "applied";
  let errorMessage: string | null = null;

  try {
    // Confirmed 2026-07-31: Legacy Colombia's listing (413494) is registered
    // in PriceLabs under pms "ownerrez" — see runDailyRateSnapshot()'s
    // comment above for the same gotcha on the read side.
    const result = await applyDateOverride(config.pricelabsListingId, "ownerrez", {
      date: input.stayDate,
      price: input.priceCents / 100,
      currency: "USD",
      reason: input.reason?.trim() || "Applied via Legacy AI Company Revenue Manager",
    });
    pricelabsResponse = result.raw;
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof PriceLabsError || err instanceof Error ? err.message : "Unknown PriceLabs error.";
  }

  const triggeredBy = input.triggeredBy ?? "manual";

  await query(
    `insert into rate_overrides
       (organization_id, property_id, stay_date, applied_price_cents, currency, ai_recommended_rate_cents, reason, pricelabs_response, status, error, triggered_by)
     values ($1, $2, $3, $4, 'USD', $5, $6, $7, $8, $9, $10)`,
    [
      orgId,
      dbPropertyId,
      input.stayDate,
      input.priceCents,
      snapshot?.ai_recommended_rate_cents ?? null,
      input.reason?.trim() || null,
      pricelabsResponse !== null ? JSON.stringify(pricelabsResponse) : null,
      status,
      errorMessage,
      triggeredBy,
    ]
  );

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: `Apply live rate for ${input.stayDate}`,
    trigger:
      triggeredBy === "auto_apply_band"
        ? `Autopilot — auto-apply band (Seni enabled REVENUE_AUTO_APPLY_ENABLED)`
        : "Seni clicked 'Apply this rate' in the Revenue Management tab",
    dataReviewed: { stayDate: input.stayDate, aiRecommendedRateCents: snapshot?.ai_recommended_rate_cents ?? null },
    decision: `Push $${(input.priceCents / 100).toFixed(2)} for ${input.stayDate} via PriceLabs override`,
    actionTaken:
      status === "applied"
        ? "Called PriceLabs POST /listings/{id}/overrides — PriceLabs will sync this into OwnerRez on its own schedule"
        : "Attempted a PriceLabs override push — the call failed, no rate changed anywhere",
    systemChanged: status === "applied" ? "PriceLabs date-specific override (pending OwnerRez sync)" : undefined,
    result: status,
    error: errorMessage ?? undefined,
  });

  if (status === "failed") {
    throw new RevenueManagerError(errorMessage ?? "PriceLabs override push failed.");
  }

  return { stayDate: input.stayDate, appliedPriceCents: input.priceCents };
}

export type RateOverrideRow = {
  stayDate: string;
  appliedPriceCents: number;
  status: string;
  createdAt: string;
  reason: string | null;
  triggeredBy: string;
};

/** The latest override attempt per stay_date — powers the "Applied" /
 * "Push failed" badge in the Revenue Management tab. */
export async function getLatestRateOverrides(
  organizationId?: string,
  propertyGroupId?: string
): Promise<RateOverrideRow[]> {
  if (!isDbConfigured()) return [];
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  const filter = await ratePropertyFilter(orgId, propertyGroupId, 2);
  const rows = await query<{
    stay_date: string;
    applied_price_cents: number;
    status: string;
    created_at: string;
    reason: string | null;
    triggered_by: string;
  }>(
    `select distinct on (stay_date) stay_date, applied_price_cents, status, created_at, reason, triggered_by
     from rate_overrides
     where organization_id = $1${filter.sql}
     order by stay_date asc, created_at desc`,
    [orgId, ...filter.params]
  );
  return rows.map((r) => ({
    stayDate: r.stay_date,
    appliedPriceCents: r.applied_price_cents,
    status: r.status,
    createdAt: r.created_at,
    reason: r.reason,
    triggeredBy: r.triggered_by,
  }));
}

// ---------- Auto-apply band (Phase 5c — ships OFF) ----------
// Seni's ask (2026-08-04 automation pass): let SMALL, low-risk rate changes
// push live automatically instead of needing a manual "Apply this rate"
// click for every date. Ships disabled — config.revenueAutoApplyEnabled must
// be explicitly flipped on via REVENUE_AUTO_APPLY_ENABLED=true in Vercel (a
// deliberate step Seni takes himself, not a dashboard toggle) before this
// does anything, per docs/VISION.md's guardrail that no agent gets
// automatic-action permission without an explicit human decision to grant
// it. Even once enabled, this only ever pushes a date whose AI-recommended
// rate is within config.revenueAutoApplyBandPct percent of OwnerRez's live
// quoted rate (a small nudge, never a large repricing), skips any date
// already pushed today (auto or manual — never double-push in one day), and
// caps how many dates a single run will touch.

const AUTO_APPLY_MAX_PER_RUN = 20;

export type AutoApplyResult = {
  enabled: boolean;
  bandPct: number;
  candidatesConsidered: number;
  applied: { stayDate: string; priceCents: number }[];
  skippedAlreadyAppliedToday: number;
  errors: { stayDate: string; error: string }[];
};

/** Called after runDailyRateSnapshot (see api/cron/revenue-snapshot) — reads
 * the snapshots just written and, only when config.revenueAutoApplyEnabled,
 * pushes any qualifying date via applyRateOverride(..., { triggeredBy:
 * "auto_apply_band" }). Always safe to call unconditionally: returns
 * enabled:false as a no-op when the flag is off, so the cron doesn't need
 * its own if-check. */
export async function runAutoApplyPass(organizationId?: string): Promise<AutoApplyResult> {
  const bandPct = config.revenueAutoApplyBandPct;
  const empty = (enabled: boolean): AutoApplyResult => ({
    enabled,
    bandPct,
    candidatesConsidered: 0,
    applied: [],
    skippedAlreadyAppliedToday: 0,
    errors: [],
  });

  if (!config.revenueAutoApplyEnabled) return empty(false);
  if (!isDbConfigured() || !isPriceLabsConfigured() || !config.pricelabsListingId) return empty(true);
  if (!Number.isFinite(bandPct) || bandPct <= 0) return empty(true);
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  const snapshots = await getLatestRateSnapshots(orgId);
  const todayStr = new Date().toISOString().slice(0, 10);

  // Dates already pushed today — auto or manual — never push the same date
  // twice in one day.
  const alreadyAppliedTodayRows = await query<{ stay_date: string }>(
    `select distinct stay_date::text from rate_overrides where organization_id = $1 and status = 'applied' and created_at::date = current_date`,
    [orgId]
  );
  const alreadyAppliedToday = new Set(alreadyAppliedTodayRows.map((r) => r.stay_date));

  const candidates = snapshots.filter((s) => {
    if (s.stayDate < todayStr) return false; // never touch the past
    if (s.aiRecommendedRateCents === null || s.ownerRezRateCents === null || s.ownerRezRateCents <= 0) return false;
    const diffPct = (Math.abs(s.aiRecommendedRateCents - s.ownerRezRateCents) / s.ownerRezRateCents) * 100;
    return diffPct <= bandPct;
  });

  const applied: { stayDate: string; priceCents: number }[] = [];
  const errors: { stayDate: string; error: string }[] = [];
  let skippedAlreadyAppliedToday = 0;

  for (const c of candidates) {
    if (applied.length >= AUTO_APPLY_MAX_PER_RUN) break;
    if (alreadyAppliedToday.has(c.stayDate)) {
      skippedAlreadyAppliedToday++;
      continue;
    }
    try {
      const result = await applyRateOverride(
        {
          stayDate: c.stayDate,
          priceCents: c.aiRecommendedRateCents as number,
          reason: `Auto-applied — AI recommendation within ${bandPct}% of OwnerRez's live rate (autopilot band, enabled by Seni)`,
          triggeredBy: "auto_apply_band",
        },
        orgId
      );
      applied.push({ stayDate: result.stayDate, priceCents: result.appliedPriceCents });
    } catch (err) {
      errors.push({ stayDate: c.stayDate, error: err instanceof Error ? err.message : "Unknown error." });
    }
  }

  await logAiActivity({
    agentKey: AGENT_KEY,
    agentDisplayName: AGENT_NAME,
    task: "Auto-apply band rate push",
    trigger: `Scheduled daily run — ${bandPct}% band, enabled by Seni via REVENUE_AUTO_APPLY_ENABLED`,
    dataReviewed: { candidatesConsidered: candidates.length, bandPct },
    decision: `Auto-applied ${applied.length} date(s); skipped ${skippedAlreadyAppliedToday} already applied today; ${errors.length} error(s)`,
    actionTaken:
      applied.length > 0
        ? `Pushed live rates via PriceLabs override for: ${applied.map((a) => a.stayDate).join(", ")}`
        : "No qualifying dates this run",
    result: errors.length > 0 ? "partial" : "logged",
  }).catch(() => {});

  return { enabled: true, bandPct, candidatesConsidered: candidates.length, applied, skippedAlreadyAppliedToday, errors };
}

// ---------- Weekday vs. weekend average rate (executive report KPI) ----------
// rate_snapshots (above) can't answer this yet: sampleDates() only ever picks
// dates that share TODAY's day-of-week within a single run, so the table
// needs the daily cron to have run for a solid week+ before every day-of-week
// is represented for the near-future dates that matter. Rather than wait on
// that, this asks OwnerRez directly for a live quote on a small, fixed set of
// near-future weekend nights (Fri/Sat — the two highest-demand STR nights)
// and weekday nights (Tue/Wed — mid-week, away from the checkout-day noise
// around Sun/Mon), same real `test: true` quote call getQuotedNightlyRateCents
// already uses elsewhere. That's up to 32 OwnerRez calls (16 candidate dates
// x up to 2 stay-length attempts each — see computeWeekdayWeekendRates for
// why the candidate count is wider than the sample size actually needed) —
// fine once a day, but this function is called
// from buildExecutiveReport(), which the Reports page re-runs on every page
// view (force-dynamic). So the result is cached in Redis for most of a day;
// only the first request after the cache expires actually pays the OwnerRez
// cost, same pattern as the thread-translation style-pool cache in
// aiReply.ts.
export const WEEKDAY_WEEKEND_CACHE_KEY = "rates:weekday-weekend";
const WEEKDAY_WEEKEND_CACHE_TTL_SECONDS = 20 * 60 * 60; // ~20h — keeps it to roughly once/day without depending on the cron

export type WeekdayWeekendRates = {
  weekdayAvgCents: number | null;
  weekendAvgCents: number | null;
  weekdaySampleSize: number;
  weekendSampleSize: number;
  computedAt: string;
};

/** Next `count` upcoming dates (starting tomorrow) that fall on one of the
 * given JS day-of-week numbers (0=Sun..6=Sat), as YYYY-MM-DD strings. */
function nextDatesOnWeekdays(weekdays: number[], count: number): string[] {
  const dates: string[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1); // start tomorrow — never quote a same-day arrival
  for (let guard = 0; dates.length < count && guard < 60; guard++) {
    if (weekdays.includes(d.getUTCDay())) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

async function computeWeekdayWeekendRates(organizationId?: string): Promise<WeekdayWeekendRates> {
  // 8 candidates each (~4 weeks of Fri/Sat and Tue/Wed) rather than 4 — a
  // quote comes back null for any date that's already booked (nothing left
  // to quote), and near-term weekend nights are exactly the ones most likely
  // to already have a guest. Casting a wider net keeps the average from
  // silently collapsing to "no data" just because the nearest couple of
  // weekends happen to be sold out.
  const weekendDates = nextDatesOnWeekdays([5, 6], 8);
  const weekdayDates = nextDatesOnWeekdays([2, 3], 8);

  const [weekendRates, weekdayRates] = await Promise.all([
    Promise.all(weekendDates.map((d) => getQuotedNightlyRateCents(d, organizationId))),
    Promise.all(weekdayDates.map((d) => getQuotedNightlyRateCents(d, organizationId))),
  ]);

  const weekendReal = weekendRates.filter((r): r is number => r !== null);
  const weekdayReal = weekdayRates.filter((r): r is number => r !== null);

  return {
    weekendAvgCents: weekendReal.length > 0 ? Math.round(weekendReal.reduce((a, b) => a + b, 0) / weekendReal.length) : null,
    weekdayAvgCents: weekdayReal.length > 0 ? Math.round(weekdayReal.reduce((a, b) => a + b, 0) / weekdayReal.length) : null,
    weekendSampleSize: weekendReal.length,
    weekdaySampleSize: weekdayReal.length,
    computedAt: new Date().toISOString(),
  };
}

/** Cached weekday/weekend rate comparison — see header comment above for why
 * this hits OwnerRez live instead of reading rate_snapshots, and why it's
 * cached. Returns nulls (with sample sizes of 0) if OwnerRez isn't
 * configured, so callers can tell "not live yet" apart from "genuinely no
 * quotes came back." */
export async function getWeekdayWeekendRates(
  organizationId?: string,
  propertyGroupId?: string
): Promise<WeekdayWeekendRates> {
  if (!isLiveModeConfigured()) {
    return { weekdayAvgCents: null, weekendAvgCents: null, weekdaySampleSize: 0, weekendSampleSize: 0, computedAt: new Date().toISOString() };
  }

  // Phase 3: this cache used to be a single global Redis key, which would
  // have silently served one tenant's rates to every other tenant once a
  // second org existed. Namespaced by org id below — falls back to the
  // single default org (same key as before this fix, since that org's id
  // is stable) when no organizationId is passed, so existing behavior is
  // unchanged for today's single-tenant deployment.
  const orgId = organizationId ?? (await getDefaultOrganizationId());
  // Group-namespaced (2026-08-17) — without this, one property's live rate
  // sample was cached under a key every other property also read.
  const cacheKey = `${WEEKDAY_WEEKEND_CACHE_KEY}:${orgId}${
    propertyGroupId && propertyGroupId !== DEFAULT_PROPERTY_GROUP_ID ? `:${propertyGroupId}` : ""
  }`;

  if (isRedisConfigured()) {
    const cached = await redisGet(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as WeekdayWeekendRates;
      } catch {
        // fall through and recompute
      }
    }
  }

  const result = await computeWeekdayWeekendRates(orgId);
  if (isRedisConfigured()) {
    await redisSet(cacheKey, JSON.stringify(result), { exSeconds: WEEKDAY_WEEKEND_CACHE_TTL_SECONDS });
  }
  return result;
}
