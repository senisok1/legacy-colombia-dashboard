#!/usr/bin/env node
// One-time setup: creates the Stripe Product + 12 Prices (6 tiers x
// monthly/annual) that lib/billing.ts's PRICING_TIERS expects, then prints
// the exact env var lines to paste into Vercel (Settings -> Environment
// Variables) and/or .env.local. Safe to re-run — it always creates NEW
// Price objects (Stripe Prices are immutable once created), so only run
// this again if you intentionally want to replace pricing; otherwise
// you'll end up with duplicate, unused Prices cluttering the dashboard.
//
// Run with: node scripts/create-stripe-prices.mjs
// Requires STRIPE_SECRET_KEY in .env.local (test mode: starts "sk_test_").
// Run it once in test mode to build/verify Checkout, then again with a
// live key ("sk_live_...") when ready to charge real cards — Products and
// Prices are separate between Stripe's test and live modes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import Stripe from "stripe";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("No STRIPE_SECRET_KEY found in .env.local. Add it first (see README's Stripe section), then rerun.");
  process.exit(1);
}

const stripe = new Stripe(secretKey);

// Mirrors src/lib/billing.ts's PRICING_TIERS — keep these two in sync by
// hand if pricing ever changes (this script only runs once at setup time,
// so there's no real benefit to importing the .ts file directly here).
const TIERS = [
  { id: "solo", name: "Solo (1 property)", monthlyCents: 5_900, annualCents: 59_000, envPrefix: "STRIPE_PRICE_SOLO" },
  { id: "starter", name: "Starter (2-5 properties)", monthlyCents: 12_900, annualCents: 129_000, envPrefix: "STRIPE_PRICE_STARTER" },
  { id: "growth", name: "Growth (6-15 properties)", monthlyCents: 29_900, annualCents: 299_000, envPrefix: "STRIPE_PRICE_GROWTH" },
  { id: "scale", name: "Scale (16-30 properties)", monthlyCents: 54_900, annualCents: 549_000, envPrefix: "STRIPE_PRICE_SCALE" },
  { id: "pro", name: "Pro (31-60 properties)", monthlyCents: 94_900, annualCents: 949_000, envPrefix: "STRIPE_PRICE_PRO" },
  { id: "portfolio", name: "Portfolio (61-100 properties)", monthlyCents: 149_900, annualCents: 1_499_000, envPrefix: "STRIPE_PRICE_PORTFOLIO" },
];

async function main() {
  console.log(`Creating Stripe Product + Prices in ${secretKey.startsWith("sk_live_") ? "LIVE" : "TEST"} mode...\n`);

  const product = await stripe.products.create({ name: "Legacy CRM Dashboard subscription" });

  const envLines = [];
  for (const tier of TIERS) {
    const monthly = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: tier.monthlyCents,
      recurring: { interval: "month" },
      nickname: `${tier.name} - monthly`,
    });
    const annual = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: tier.annualCents,
      recurring: { interval: "year" },
      nickname: `${tier.name} - annual`,
    });
    envLines.push(`${tier.envPrefix}_MONTHLY=${monthly.id}`);
    envLines.push(`${tier.envPrefix}_ANNUAL=${annual.id}`);
    console.log(`${tier.name}: monthly ${monthly.id}, annual ${annual.id}`);
  }

  console.log("\nPaste these into Vercel (Project Settings -> Environment Variables) and .env.local:\n");
  console.log(envLines.join("\n"));
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
