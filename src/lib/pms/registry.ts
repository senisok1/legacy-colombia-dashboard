import type { PmsProvider } from "./types";

// The one seam a future PMS migration (OwnerRez -> Hostaway, or eventually
// pulling directly from each OTA's own API instead of any PMS at all) hangs
// off of. Today there's exactly one real adapter and every organization uses
// it; getPmsProvider() is still the right thing for any NEW code to call
// (rather than importing lib/ownerrez.ts directly) so it's already wired up
// for the day a second adapter exists.
export type PmsProviderId = "ownerrez";

const DEFAULT_PROVIDER_ID: PmsProviderId = "ownerrez";

// Dynamic import avoids a circular import at module-eval time — ownerrez.ts
// imports the PmsProvider *type* from ./types (erased at build time, so no
// runtime cycle there), but this file would otherwise need a real runtime
// import of ownerrez.ts, and ownerrez.ts doesn't need to know this registry
// exists at all.
async function loadOwnerRezProvider(): Promise<PmsProvider> {
  const { ownerRezProvider } = await import("../ownerrez");
  return ownerRezProvider;
}

/**
 * Resolves which PMS adapter a given organization's data should come
 * from/go to. Once a second adapter (Hostaway, say) actually exists, this
 * should read the org's own choice — a "pms_provider" credential key,
 * mirroring the pattern in lib/credentials.ts — instead of always returning
 * the hardcoded default. Reading that now, before any second option is
 * real, would just add a DB round trip that always resolves the same way.
 */
export async function getPmsProvider(organizationId?: string): Promise<PmsProvider> {
  void organizationId; // unused until a second provider exists to choose between
  const providerId: PmsProviderId = DEFAULT_PROVIDER_ID;

  switch (providerId) {
    case "ownerrez":
      return loadOwnerRezProvider();
    default: {
      // Exhaustiveness guard — if PmsProviderId ever grows a new member
      // without a case above, this line fails to compile.
      const neverProviderId: never = providerId;
      throw new Error(`Unknown PMS provider id: ${neverProviderId}`);
    }
  }
}
