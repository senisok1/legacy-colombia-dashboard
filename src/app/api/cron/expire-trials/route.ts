import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { expireLapsedTrials } from "@/lib/organizations";

// Nightly trial-expiry sweep (2026-08-17 audit). Flips every org still marked
// 'trialing' whose trial_ends_at has passed to 'canceled' (see
// expireLapsedTrials in lib/organizations.ts).
//
// WHY THIS EXISTS: with open public signup (api/signup), nothing ever demoted
// an abandoned trial out of 'trialing'. Every other cron (check-messages,
// detect-reviews, detect-campaigns, revenue-snapshot, ...) iterates
// listActiveOrganizations(), which included every trialing org forever — so
// each new signup permanently added per-org work to every cron run, unbounded,
// starving the one real tenant's cron-time/API budget. This sweep, plus the
// belt-and-suspenders "trial_ends_at in the past is excluded immediately"
// clause now in listActiveOrganizations, keeps that loop bounded.
//
// Purely a status flip — it does NOT delete any org or data, so a lapsed trial
// that later converts (Stripe webhook sets 'active') simply rejoins the loop.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // CRON AUTH — FAIL CLOSED IN PRODUCTION (2026-08-17 audit). Same pattern as
  // api/cron/detect-reviews: if CRON_SECRET is unset we refuse to run in
  // production (a missing secret is a misconfiguration, not an invitation to
  // run wide open), and only allow unauthenticated runs in non-production
  // (local dev / preview) so testing stays easy.
  const isProd = process.env.VERCEL_ENV === "production";
  if (!config.cronSecret) {
    if (isProd) {
      console.error(
        "[cron/expire-trials] CRON_SECRET is not set in production — refusing to run this endpoint unauthenticated. Set CRON_SECRET in Vercel."
      );
      return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
    }
    console.warn("[cron/expire-trials] CRON_SECRET unset — running WITHOUT auth (non-production only).");
  } else {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${config.cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ skipped: "Database isn't connected yet." });
  }

  // Defensive: never let a DB hiccup turn into a 500 the Vercel scheduler
  // would surface as a failed cron. Log loudly and return a 200 with the
  // error captured — the next nightly run just tries again.
  try {
    const expired = await expireLapsedTrials();
    return NextResponse.json({ ok: true, expired });
  } catch (err) {
    console.error("[cron/expire-trials] sweep failed", err);
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error.",
    });
  }
}
