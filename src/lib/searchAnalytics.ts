import { createSign } from "crypto";
import { config } from "./config";
import { DEFAULT_PROPERTY_GROUP_ID } from "./propertyGroups";

// Real Search Console + GA4 data for the Marketing tab (task #172). Replaces
// contentMarketing.ts's "no live search data" limitation for the SEO side —
// content drafting there is still Claude's general knowledge only, but the
// numbers shown here (clicks, impressions, queries, pages, sessions) are
// pulled live from Google.
//
// Auth: a Google Cloud service account (see config.ts's googleServiceAccountKey
// comment), granted Viewer access directly on the legacycolombia.com Search
// Console property and the Legacy Colombia GA4 property ONLY — Seni's Google
// account has other unrelated sites on it and this must never touch them. We
// sign our own RS256 JWT and exchange it for an access token (the standard
// "server-to-server" OAuth flow for service accounts) rather than pulling in
// the full googleapis SDK — same lightweight-fetch-client pattern as
// lib/pricelabs.ts.
//
// GA4 tracking wasn't actually installed on the site as of 2026-08-02 (Site
// Kit install deferred at Seni's request — task #175), so getGa4Overview()
// below will return real zeros, not fake/estimated numbers, until that's
// done. Never backfill these with guessed traffic figures.

export class SearchAnalyticsError extends Error {}

/** Env-var suffix for a property group: "legacy-alva" -> "LEGACY_ALVA". */
function envSuffix(propertyGroupId: string): string {
  return propertyGroupId.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
}

/** Search Console site for a property (2026-08-17). The default group uses
 * GSC_SITE_URL; any other group uses GSC_SITE_URL_<GROUP>, e.g.
 * GSC_SITE_URL_LEGACY_ALVA. Returns "" when that property has no site
 * configured — callers surface that as "not connected" rather than silently
 * falling back to Legacy Colombia's numbers, which is the bug this fixes. */
export function gscSiteUrlFor(propertyGroupId?: string): string {
  if (!propertyGroupId || propertyGroupId === DEFAULT_PROPERTY_GROUP_ID) return config.gscSiteUrl;
  return (process.env[`GSC_SITE_URL_${envSuffix(propertyGroupId)}`] || "").trim();
}

/** GA4 property id for a property group — same scheme as gscSiteUrlFor(). */
export function ga4PropertyIdFor(propertyGroupId?: string): string {
  if (!propertyGroupId || propertyGroupId === DEFAULT_PROPERTY_GROUP_ID) return config.ga4PropertyId;
  return (process.env[`GA4_PROPERTY_ID_${envSuffix(propertyGroupId)}`] || "").trim();
}

/** Turns a raw Search Console site identifier ("sc-domain:legacycolombia.com",
 * "https://www.legacyalva.com/") into a plain domain for display
 * ("legacycolombia.com", "legacyalva.com"). Used by SearchAnalyticsPanel so
 * the "scoped only to ___" line actually names the property being viewed
 * instead of a string baked in at Colombia's original launch (2026-08-18,
 * Seni: the panel said "legacycolombia.com" under every property). */
export function displaySiteDomain(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

function loadServiceAccount(): ServiceAccountKey {
  if (!config.googleServiceAccountKey) {
    throw new SearchAnalyticsError("GOOGLE_SERVICE_ACCOUNT_KEY isn't set yet.");
  }
  try {
    const parsed = JSON.parse(config.googleServiceAccountKey) as ServiceAccountKey;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("missing client_email or private_key");
    }
    return parsed;
  } catch (err) {
    throw new SearchAnalyticsError(
      `GOOGLE_SERVICE_ACCOUNT_KEY isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// In-memory access-token cache, keyed by scope. Serverless functions are
// short-lived so this mostly helps within a single invocation (e.g. when a
// page fetches both Search Console and GA4), but costs nothing to keep.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(scope: string): Promise<string> {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const account = loadServiceAccount();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope,
      aud: account.token_uri || TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(account.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(account.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SearchAnalyticsError(`Google token endpoint returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new SearchAnalyticsError("Google token endpoint returned no access_token.");

  tokenCache.set(scope, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type SearchConsoleRow = {
  key: string; // the query string or page URL
  clicks: number;
  impressions: number;
  ctr: number; // 0-1
  position: number;
};

export type SearchConsolePerformance = {
  siteUrl: string;
  startDate: string;
  endDate: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries: SearchConsoleRow[];
  topPages: SearchConsoleRow[];
};

type GscApiRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };

async function querySearchConsole(
  siteUrl: string,
  token: string,
  body: Record<string, unknown>
): Promise<GscApiRow[]> {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new SearchAnalyticsError(`Search Console API returned ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = (await res.json()) as { rows?: GscApiRow[] };
  return data.rows ?? [];
}

/** Real Search Console performance for the last `days` days (default 28,
 * matching Search Console's own default UI window), scoped ONLY to
 * config.gscSiteUrl (sc-domain:legacycolombia.com) — never any other
 * property on Seni's Google account. */
export async function getSearchConsolePerformance(
  days = 28,
  propertyGroupId?: string
): Promise<SearchConsolePerformance> {
  const siteUrl = gscSiteUrlFor(propertyGroupId);
  if (!config.googleServiceAccountKey || !siteUrl) {
    throw new SearchAnalyticsError(
      propertyGroupId && propertyGroupId !== DEFAULT_PROPERTY_GROUP_ID
        ? `No Search Console site is connected for this property yet (set GSC_SITE_URL_${envSuffix(propertyGroupId)}).`
        : "GSC_SITE_URL / GOOGLE_SERVICE_ACCOUNT_KEY isn't set yet."
    );
  }
  const token = await getAccessToken(SEARCH_CONSOLE_SCOPE);

  // Search Console's data lags ~2-3 days behind real time, so end the window
  // a few days back rather than "today" to avoid an incomplete-looking tail.
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const startDate = toDateString(start);
  const endDate = toDateString(end);

  const [totalsRows, queryRows, pageRows] = await Promise.all([
    querySearchConsole(siteUrl, token, { startDate, endDate, dimensions: [] }),
    querySearchConsole(siteUrl, token, { startDate, endDate, dimensions: ["query"], rowLimit: 15 }),
    querySearchConsole(siteUrl, token, { startDate, endDate, dimensions: ["page"], rowLimit: 15 }),
  ]);

  const totalsRow = totalsRows[0];
  const toRow = (r: GscApiRow): SearchConsoleRow => ({
    key: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  });

  return {
    siteUrl,
    startDate,
    endDate,
    totals: {
      clicks: totalsRow?.clicks ?? 0,
      impressions: totalsRow?.impressions ?? 0,
      ctr: totalsRow?.ctr ?? 0,
      position: totalsRow?.position ?? 0,
    },
    topQueries: queryRows.map(toRow),
    topPages: pageRows.map(toRow),
  };
}

export type Ga4Overview = {
  propertyId: string;
  startDate: string;
  endDate: string;
  sessions: number;
  activeUsers: number;
  pageViews: number;
  /** True when GA4 returned zero rows entirely — most likely because
   * tracking isn't installed on the site yet (task #175), not because
   * traffic was actually zero. Let the UI say so explicitly rather than
   * showing an unexplained "0". */
  noData: boolean;
};

/** Real GA4 totals for the last `days` days, scoped ONLY to
 * config.ga4PropertyId (the Legacy Colombia property) — never any other
 * property on Seni's Google account. Returns real zeros (not estimates) if
 * GA4 has no tracking data yet. */
export async function getGa4Overview(days = 28, propertyGroupId?: string): Promise<Ga4Overview> {
  const propertyId = ga4PropertyIdFor(propertyGroupId);
  if (!config.googleServiceAccountKey || !propertyId) {
    throw new SearchAnalyticsError(
      propertyGroupId && propertyGroupId !== DEFAULT_PROPERTY_GROUP_ID
        ? `No GA4 property is connected for this property yet (set GA4_PROPERTY_ID_${envSuffix(propertyGroupId)}).`
        : "GA4_PROPERTY_ID / GOOGLE_SERVICE_ACCOUNT_KEY isn't set yet."
    );
  }
  const token = await getAccessToken(GA4_SCOPE);

  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SearchAnalyticsError(`GA4 Data API returned ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as { rows?: { metricValues?: { value?: string }[] }[] };
  const row = data.rows?.[0];
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  if (!row) {
    return {
      propertyId,
      startDate: toDateString(start),
      endDate: toDateString(end),
      sessions: 0,
      activeUsers: 0,
      pageViews: 0,
      noData: true,
    };
  }

  const sessions = Number(row.metricValues?.[0]?.value ?? 0);
  const activeUsers = Number(row.metricValues?.[1]?.value ?? 0);
  const pageViews = Number(row.metricValues?.[2]?.value ?? 0);
  return {
    propertyId,
    startDate: toDateString(start),
    endDate: toDateString(end),
    sessions,
    activeUsers,
    pageViews,
    noData: sessions === 0 && activeUsers === 0 && pageViews === 0,
  };
}
