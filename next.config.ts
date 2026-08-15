import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // tsc --noEmit is run as a separate verification step before every deploy
  // (see CLAUDE.md build pipeline) — skip the duplicate, slower in-build
  // type-check here so `next build` finishes faster.
  typescript: { ignoreBuildErrors: true },
  // api/admin/migrate/route.ts reads db/migrations/*.sql at runtime via
  // fs.readdirSync() on a dynamically-built path — Next's automatic
  // serverless file tracing doesn't reliably follow that (it's built for
  // statically-analyzable imports, not directory listings), so newer
  // migration files can silently get left out of the deployed function's
  // bundle even though the .sql files are committed and the rest of the
  // app deploys fine. Found 2026-08-05: hitting the live /api/admin/migrate
  // only knew about migrations up through 0011 even though 0012-0018 had
  // shipped across several redeploys since. This explicitly forces the
  // whole directory into that route's bundle every build.
  outputFileTracingIncludes: {
    "/api/admin/migrate": ["./db/migrations/**"],
  },
};

export default nextConfig;
