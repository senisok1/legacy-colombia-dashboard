import { redisGet, redisSet } from "./redis";

// Hostaway PMS client (2026-08-17). Legacy Pompano is managed in Hostaway,
// not OwnerRez — OwnerRez only receives its calendar over iCal, which is why
// 233 of its 246 "bookings" arrived as $0 availability blocks with no guest
// and no money attached. The real reservations, guests and messages only
// exist in Hostaway, so they have to come from Hostaway's own API.
//
// Auth is OAuth2 client-credentials: POST /v1/accessTokens with the Account
// ID as client_id and the API Key as client_secret, scope "general". The
// returned bearer token is long-lived (Hostaway issues up to 24 months), so
// it's cached in Redis rather than re-minted per request — Hostaway
// documents these as scarce, and re-requesting one on every call would be
// both slow and rude.
//
// Same "call the provider's HTTP API directly, no SDK" style as
// lib/ownerrez.ts and lib/whatsapp.ts.

export class HostawayError extends Error {}

const BASE_URL = "https://api.hostaway.com/v1";
const TOKEN_CACHE_KEY = "hostaway:access-token";
// Deliberately far shorter than the token's real lifetime — a cache that
// outlives a revoked/rotated key is worse than re-minting occasionally.
const TOKEN_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;

export function hostawayAccountId(): string {
  return (process.env.HOSTAWAY_ACCOUNT_ID || "").trim();
}

export function hostawayApiKey(): string {
  return (process.env.HOSTAWAY_API_KEY || "").trim();
}

export function isHostawayConfigured(): boolean {
  return Boolean(hostawayAccountId() && hostawayApiKey());
}

async function mintAccessToken(): Promise<string> {
  const accountId = hostawayAccountId();
  const apiKey = hostawayApiKey();
  if (!accountId || !apiKey) {
    throw new HostawayError("Hostaway isn't configured — set HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_KEY.");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: accountId,
    client_secret: apiKey,
    scope: "general",
  });

  const res = await fetch(`${BASE_URL}/accessTokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Hostaway's docs specify this header on the token call specifically.
      "Cache-Control": "no-cache",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HostawayError(`Hostaway token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { access_token?: string; token_type?: string };
  if (!json.access_token) {
    throw new HostawayError("Hostaway token response contained no access_token.");
  }
  return json.access_token;
}

export async function getHostawayToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await redisGet(TOKEN_CACHE_KEY).catch(() => null);
    if (cached) return cached;
  }
  const token = await mintAccessToken();
  await redisSet(TOKEN_CACHE_KEY, token, { exSeconds: TOKEN_CACHE_TTL_SECONDS }).catch(() => {});
  return token;
}

/**
 * Raw authenticated GET against the Hostaway API.
 *
 * Retries ONCE on a 401/403 with a freshly minted token, since the cached
 * one may have been revoked or rotated in the Hostaway dashboard — that's
 * the single failure mode where retrying is both safe and likely to work.
 */
export async function hostawayGet<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const attempt = async (token: string) =>
    fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
    });

  let res = await attempt(await getHostawayToken());
  if (res.status === 401 || res.status === 403) {
    res = await attempt(await getHostawayToken(true));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HostawayError(`Hostaway GET ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Walks Hostaway's limit/offset pagination until a short page comes back. */
export async function hostawayGetAll<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  pageSize = 100,
  maxPages = 60
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const json = await hostawayGet<{ result?: T[] }>(path, {
      ...params,
      limit: pageSize,
      offset: page * pageSize,
    });
    const batch = Array.isArray(json.result) ? json.result : [];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}
