import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { detectAndDraftResponses } from "@/lib/reputationManager";
import { listActiveOrganizations } from "@/lib/organizations";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";

// Daily scan for reviews with no host response yet — drafts an AI response
// for each and notifies Seni once over WhatsApp (see
// lib/reputationManager.ts's header comment). Runs once a day via
// vercel.json's cron entry, same pattern as api/cron/detect-campaigns. Only
// ever CREATES 'pending_review' rows for Seni to review in the Reputation
// tab — never posts anything anywhere.
//
// Phase 3: loops over every organization in good standing rather than
// running once for the single default org — see detect-campaigns' matching
// comment for the reasoning.
//
// PER-PROPERTY DETECTION (2026-08-17 audit): this previously called
// detectAndDraftResponses(org.id) with NO property group, so it defaulted to
// Legacy Colombia and drafted review responses ONLY for Colombia — the other
// four properties (Alva, Pompano, Miami, Beach House) never got a single
// review response drafted, completely silently. Now it iterates every
// property group and drafts per property. Each group is wrapped in its own
// try/catch so one property's failure (bad OwnerRez data, an AI hiccup) never
// stops the remaining properties from being scanned.
// Raised from 60s to 300s to match detect-campaigns: a five-property pass,
// each doing live data reads plus per-review AI drafting, would have been cut
// off partway at 60s, silently leaving later properties undrafted.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // CRON AUTH — FAIL CLOSED IN PRODUCTION (2026-08-17 audit). This guard used
  // to be `if (config.cronSecret) { check }`, which meant that if CRON_SECRET
  // was ever unset in production the check was skipped entirely and this
  // endpoint ran wide open to anyone who found the URL — and it triggers live
  // OwnerRez reads and AI drafting. Now a missing secret is treated as a
  // misconfiguration and rejected in production (503 + loud console.error);
  // only non-production (VERCEL_ENV !== "production" — local dev / preview
  // deploys) is allowed to run without a secret, so local testing stays easy.
  const isProd = process.env.VERCEL_ENV === "production";
  if (!config.cronSecret) {
    if (isProd) {
      console.error(
        "[cron/detect-reviews] CRON_SECRET is not set in production — refusing to run this endpoint unauthenticated. Set CRON_SECRET in Vercel."
      );
      return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
    }
    console.warn("[cron/detect-reviews] CRON_SECRET unset — running WITHOUT auth (non-production only).");
  } else {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${config.cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ skipped: "Database isn't connected yet." });
  }

  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    try {
      // Per-property fan-out — see the header note. detectAndDraftResponses
      // scopes both the review listing and the drafted rows to the group id.
      const perProperty: Record<string, unknown> = {};
      for (const group of PROPERTY_GROUPS) {
        try {
          perProperty[group.id] = await detectAndDraftResponses(org.id, group.id);
        } catch (groupErr) {
          // One property failing shouldn't stop the others being scanned.
          console.error(`[cron/detect-reviews] ${org.slug}/${group.id} failed`, groupErr);
          perProperty[group.id] = {
            error: groupErr instanceof Error ? groupErr.message : "Unknown error.",
          };
        }
      }
      results[org.slug] = { ok: true, perProperty };
    } catch (err) {
      console.error(`[cron/detect-reviews] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}
