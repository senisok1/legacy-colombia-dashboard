async function getStatus() {
  const { config, isLiveModeConfigured } = await import("@/lib/config");
  const { testConnection } = await import("@/lib/ownerrez");
  const { getServerSession } = await import("@/lib/session");
  // Phase 3 smoke-test finding (2026-08-05): this component renders on every
  // page via the root layout and was calling testConnection() with no
  // organizationId, so every tenant's dashboard — including a brand new
  // signup with no OwnerRez credentials of its own — showed the DEFAULT
  // org's (Legacy Colombia's) live connection status and property name in
  // the banner at the top of every page. Not a page.tsx entry point, so it
  // wasn't caught by the earlier per-page session-wiring pass.
  const session = await getServerSession();
  const demoMode = !isLiveModeConfigured();
  const connection = await testConnection(session?.organizationId);
  return { demoMode, propertyName: config.propertyName, connection };
}

export async function StatusBanner() {
  const { demoMode, propertyName, connection } = await getStatus();

  if (demoMode) {
    return (
      <div className="mx-auto max-w-6xl px-6 pt-4">
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-sm px-4 py-2 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-200">
          <strong>Demo mode</strong> — showing sample data. Add your OwnerRez credentials to{" "}
          <code className="font-mono">.env.local</code> to connect to the real{" "}
          <strong>{propertyName}</strong> account. See README.md for setup steps.
        </div>
      </div>
    );
  }

  if (!connection.ok) {
    return (
      <div className="mx-auto max-w-6xl px-6 pt-4">
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-900 text-sm px-4 py-2 dark:bg-red-950/40 dark:border-red-900 dark:text-red-200">
          <strong>Connection issue:</strong> {connection.message}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pt-4">
      <div className="rounded-lg border border-green-300 bg-green-50 text-green-900 text-sm px-4 py-2 dark:bg-green-950/40 dark:border-green-900 dark:text-green-200">
        {connection.message}
      </div>
    </div>
  );
}
