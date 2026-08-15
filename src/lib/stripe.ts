import Stripe from "stripe";
import { config } from "./config";

// Thin singleton wrapper — same shape as lib/db.ts's pool getter. Every
// caller (checkout route, portal route, webhook handler) goes through this
// instead of constructing its own Stripe client.
let client: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY isn't set on this deployment.");
  }
  if (!client) {
    client = new Stripe(config.stripeSecretKey);
  }
  return client;
}
