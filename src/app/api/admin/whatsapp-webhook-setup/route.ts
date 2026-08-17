import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Everything needed to re-point Meta's WhatsApp webhook at a secured
// callback URL (2026-08-17 audit) — the POST handler previously accepted
// any unauthenticated payload, and a forged one could approve a pending
// draft, which sends a real message to a real guest.
//
// Returns the exact Callback URL and Verify Token to paste into
// Meta for Developers -> WhatsApp -> Configuration -> Edit.
//
// WHY THE VERIFY TOKEN IS SAFE TO RETURN HERE. It is not a credential and
// grants no access to anything: it's an arbitrary string this app and Meta
// echo at each other once, during the GET handshake, to prove the URL owner
// configured the subscription (see config.ts's whatsappVerifyToken comment,
// "you can set this to anything"). The route is ADMIN_SECRET-gated anyway.
//
// WHATSAPP_WEBHOOK_SECRET is deliberately NOT returned in full — it's the
// thing actually protecting the endpoint. The URL is returned assembled so
// it can be pasted without ever displaying the secret on its own.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const webhookSecret = (process.env.WHATSAPP_WEBHOOK_SECRET || "").trim();
  const appSecret = (process.env.WHATSAPP_APP_SECRET || "").trim();
  const base = "https://crm.legacyestaterentals.com/api/whatsapp/webhook";

  // Self-test (2026-08-17): proves which rung of the ladder is actually
  // ACTIVE by exercising the deployed endpoint, rather than inferring it
  // from which env vars happen to be present. `expect` states what a
  // correctly-configured deployment must return, so a mismatch is obvious.
  async function probe(path: string, headers: Record<string, string> = {}): Promise<number> {
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
        cache: "no-store",
      });
      return res.status;
    } catch {
      return 0;
    }
  }

  // Is the App Secret actually CORRECT? (2026-08-17)
  //
  // The probes above prove the endpoint now REQUIRES a signature — but a
  // mistyped secret passes every one of them while silently rejecting every
  // real Meta delivery, which would kill guest messaging with no error
  // anywhere obvious. Nothing in this app can detect that on its own,
  // because a wrong secret and a forged request look identical.
  //
  // Meta's appsecret_proof settles it: an HMAC of the access token keyed by
  // the app secret, which Graph validates server-side. A 200 means the
  // secret we hold is the one Meta has. Never logs or returns the secret.
  async function appSecretMatchesMeta(): Promise<{ ok: boolean; detail: string }> {
    if (!appSecret) return { ok: false, detail: "WHATSAPP_APP_SECRET is not set." };
    const token = config.whatsappAccessToken;
    if (!token) return { ok: false, detail: "WHATSAPP_ACCESS_TOKEN isn't set, so this can't be checked." };
    try {
      const { createHmac } = await import("node:crypto");
      const proof = createHmac("sha256", appSecret).update(token, "utf8").digest("hex");
      const res = await fetch(
        `https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(token)}&appsecret_proof=${proof}`,
        { cache: "no-store" }
      );
      if (res.ok) return { ok: true, detail: "Meta accepted an appsecret_proof built from this secret." };
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      const message = body.error?.message ?? `HTTP ${res.status}`;
      return {
        ok: false,
        detail: /appsecret_proof/i.test(message)
          ? "Meta REJECTED the proof — the stored App Secret does not match this app. Real WhatsApp messages are being dropped. Re-copy it from Settings -> Basic."
          : `Couldn't confirm: ${message}`,
      };
    } catch (err) {
      return { ok: false, detail: `Couldn't reach Meta: ${err instanceof Error ? err.message : "unknown"}` };
    }
  }

  const runProbe = req.nextUrl.searchParams.get("probe") === "1";
  const probes = runProbe
    ? {
        noProof: {
          got: await probe(""),
          expect: appSecret || webhookSecret ? 401 : 200,
          means: "an anonymous forged request",
        },
        urlSecretOnly: {
          got: webhookSecret ? await probe(`?secret=${encodeURIComponent(webhookSecret)}`) : null,
          // THIS is the line that proves the upgrade: once the App Secret is
          // set, a valid URL secret with no signature must ALSO be rejected.
          expect: appSecret ? 401 : webhookSecret ? 200 : null,
          means: "URL secret alone — must stop working once the App Secret is set",
        },
        garbageSignature: {
          got: await probe("", { "X-Hub-Signature-256": `sha256=${"z".repeat(64)}` }),
          expect: appSecret || webhookSecret ? 401 : 200,
          means: "a malformed signature must be a clean 401, never a 500",
        },
      }
    : null;

  return NextResponse.json({
    callbackUrl: webhookSecret ? `${base}?secret=${encodeURIComponent(webhookSecret)}` : base,
    verifyToken: config.whatsappVerifyToken || null,
    protection: appSecret
      ? "HMAC (WHATSAPP_APP_SECRET) — strongest; the payload itself is signed, and the URL secret alone is no longer accepted"
      : webhookSecret
        ? "URL secret (WHATSAPP_WEBHOOK_SECRET) — authenticates the caller, not the payload"
        : "NONE — endpoint currently accepts unverified payloads",
    appSecretSet: Boolean(appSecret),
    urlSecretSet: Boolean(webhookSecret),
    appSecretMatchesMeta: runProbe ? await appSecretMatchesMeta() : null,
    probes,
    note: runProbe
      ? "Every probe's `got` should equal its `expect`."
      : "Add ?probe=1 to actively test the deployed endpoint.",
  });
}
