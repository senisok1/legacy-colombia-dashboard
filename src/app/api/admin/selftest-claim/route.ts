import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { redisSetNX, redisDel } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proves the atomic send-claim actually serializes concurrent actors against
// the REAL production Redis (2026-08-17 audit). The double-send fix rests
// entirely on redisSetNX returning true for exactly one of N racing callers;
// this fires many concurrent NX writes at one key and asserts precisely one
// wins. A unit test against a mock would prove nothing about the deployed
// Redis. Self-cleans the probe key. ADMIN_SECRET-gated.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const key = `selftest:claim:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => redisSetNX(key, "x", 30).catch(() => false))
    );
    const winners = results.filter(Boolean).length;
    await redisDel(key).catch(() => {});
    return NextResponse.json({
      concurrentClaims: N,
      winners,
      pass: winners === 1,
      note:
        winners === 1
          ? "Exactly one concurrent claim won — the approval double-send guard is sound against live Redis."
          : `Expected exactly 1 winner, got ${winners}. redisSetNX is NOT atomic here — do not trust the send-claim.`,
    });
  } catch (err) {
    await redisDel(key).catch(() => {});
    return NextResponse.json(
      { pass: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
